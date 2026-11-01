/**
 * Report delivery (S-001 R-8a, R-17): when an invoked agent's run ends and it isn't parked, its part is done, and its
 * last answer becomes new input to the invoking conversation. A running invoker gets it as a follow-up, an idle or
 * parked one is continued. The request id `report:<invokedId>:<entryId>` makes a repeat harmless, and an invoked id
 * stays in the invoker's `awaiting` until its report is delivered, so a restart redelivers what a crash cut off.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import type { Logger } from "../daemon/logger.ts";
import { submitInput } from "./conversation_control.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { watchInstance } from "./host_observation.ts";
import { continueParked } from "./invocation.ts";
import { type ConversationMeta, conversationMetaDoc, readConversationMeta, type SeatActor } from "./seating.ts";

const context = BACKGROUND_CONTEXT;
const ENTRY_PAGE_SIZE = 20;

type Report = { content: string; requestId: string };

const toNumericId = (conversationId: string): ConversationId => Number(conversationId) as ConversationId;

const isAssistantMessage = (message: Message): message is AssistantMessage => message.role === "assistant";

function textOfAssistant(message: AssistantMessage): string {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

// The report is the text of the last assistant message; entries are read newest first.
async function readReport(host: HarnessHost, invokedId: string): Promise<Report | undefined> {
    const conversation: Conversation | undefined = await internalHarness(host).conversation(
        toNumericId(invokedId),
        context,
    );
    if (conversation === undefined) return undefined;
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    do {
        const page = await conversation.entries({ order: "descending" }, ENTRY_PAGE_SIZE, cursor, context);
        for (const entry of page.items) {
            const message = entry.model?.findLast(isAssistantMessage);
            if (message !== undefined) {
                return { content: textOfAssistant(message), requestId: `report:${invokedId}:${entry.id}` };
            }
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
}

async function changeMeta(host: HarnessHost, conversationId: string, change: (meta: ConversationMeta) => void) {
    await internalHarness(host).commit(async (tx) => {
        change((await tx.doc(conversationMetaDoc, toNumericId(conversationId))) as ConversationMeta);
    }, context);
}

const withoutId = (ids: string[], id: string): string[] => ids.filter((candidate) => candidate !== id);

// One commit moves an earlier report into `held` and out of `awaiting`, so a crash never loses or repeats it.
async function holdReport(host: HarnessHost, input: { invokerId: string; invokedId: string; report: Report }) {
    const { invokerId, invokedId, report } = input;
    const actor: SeatActor = { kind: "agent", conversationId: invokedId, role: "" };
    await changeMeta(host, invokerId, (meta) => {
        if (!meta.held.some((message) => message.requestId === report.requestId)) {
            meta.held.push({ content: report.content, mode: "followUp", actor, requestId: report.requestId });
        }
        meta.awaiting = withoutId(meta.awaiting, invokedId);
    });
}

async function deliver(host: HarnessHost, invokedId: string): Promise<void> {
    const invoked = await readConversationMeta(host, invokedId);
    if (invoked?.invokedBy === undefined || invoked.parked !== null) return;
    const invokerId = invoked.invokedBy;
    const invoker = await readConversationMeta(host, invokerId);
    if (invoker === undefined || !invoker.awaiting.includes(invokedId)) return;
    if ((await host.conversationInfo(invokedId))?.busy !== false) return;
    const report = await readReport(host, invokedId);
    if (report === undefined) return;

    const isLastReport = withoutId(invoker.awaiting, invokedId).length === 0;
    if (invoker.parked?.continueOn === "all" && !isLastReport) {
        await holdReport(host, { invokerId, invokedId, report });
        return;
    }
    if (invoker.parked !== null || invoker.held.length > 0) {
        await continueParked(host, invokerId, report);
    } else {
        await submitInput(host, invokerId, { ...report, busyMode: "followUp" });
    }
    await changeMeta(host, invokerId, (meta) => {
        meta.awaiting = withoutId(meta.awaiting, invokedId);
    });
}

/**
 * Delivers the report of every invoked conversation whose run finishes, and first the reports a crash cut off.
 * Reports are delivered one at a time, in the order the runs finished.
 */
export async function startReportDelivery(host: HarnessHost, options: { logger: Logger }): Promise<{ stop(): void }> {
    let queue: Promise<void> = Promise.resolve();
    let isStopped = false;
    const enqueue = (invokedId: string): void => {
        queue = queue.then(async () => {
            if (isStopped) return;
            try {
                await deliver(host, invokedId);
            } catch (error) {
                options.logger.error("report delivery failed", {
                    conversation: invokedId,
                    cause: error instanceof Error ? error.message : String(error),
                });
            }
        });
    };

    const watch = await watchInstance(host, (event) => {
        if (event.type === "run_finished") enqueue(event.conversationId);
    });
    for (const { id, busy } of watch.snapshot.conversations) {
        if (!busy) enqueue(id);
    }
    return {
        stop() {
            isStopped = true;
            watch.stop();
        },
    };
}
