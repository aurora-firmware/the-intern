/**
 * Report delivery (S-001 REQ-019, REQ-017): when an invoked agent's run ends while it isn't parked and awaits no
 * report, its part is done, and its last answer becomes new input to the invoking conversation. A running invoker gets
 * it as a follow-up, an idle or parked one is continued. The request id `report:<invokedId>:<entryId>` makes a repeat
 * harmless, and an invoked id stays in the invoker's `awaiting` until its report is delivered, so a restart redelivers
 * what a crash cut off.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import type { Logger } from "../daemon/logger.ts";
import { submitInput } from "./conversation_control.ts";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { watchConversationMeta, watchInstance } from "./host_observation.ts";
import { continueParked } from "./invocation.ts";
import { ConversationClosedError, inOpenConversation, isConversationClosed } from "./job_section.ts";
import { type ConversationMeta, conversationMetaDoc, readConversationMeta, type SeatActor } from "./seating.ts";

const context = BACKGROUND_CONTEXT;
const ENTRY_PAGE_SIZE = 20;

/** The entry a report is placed as: it names the invoked conversation and its role, and carries the report text. */
export const REPORT_KIND = "intern.report";
export type ReportRecord = { actor: SeatActor; content: string };

type Report = { content: string; requestId: string };
type LastAnswer = { text: string; entryId: EntryId };

const isAssistantMessage = (message: Message): message is AssistantMessage => message.role === "assistant";

function textOfAssistant(message: AssistantMessage): string {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

// The last answer is the text of the last assistant message; entries are read newest first.
async function readLastAnswer(host: HarnessHost, invokedId: string): Promise<LastAnswer | undefined> {
    const conversation: Conversation | undefined = await internalHarness(host).conversation(
        toConversationId(invokedId),
        context,
    );
    if (conversation === undefined) return undefined;
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    do {
        const page = await conversation.entries({ order: "descending" }, ENTRY_PAGE_SIZE, cursor, context);
        for (const entry of page.items) {
            const message = entry.model?.findLast(isAssistantMessage);
            if (message !== undefined) {
                return { text: textOfAssistant(message), entryId: entry.id };
            }
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
}

// An aborted conversation reports that it was aborted. With a last answer the request id is the ordinary report's, so
// a report admitted just before the abort is not delivered a second time.
function abortedReport(invokedId: string, role: string, answer: LastAnswer | undefined): Report {
    const sentence = `Conversation ${invokedId} (${role}) was aborted.`;
    if (answer === undefined) return { content: sentence, requestId: `report:${invokedId}:aborted` };
    return {
        content: `${sentence}\n\nIts last answer:\n${answer.text}`,
        requestId: `report:${invokedId}:${answer.entryId}`,
    };
}

async function readReport(
    host: HarnessHost,
    invoked: ConversationMeta,
    invokedId: string,
): Promise<Report | undefined> {
    const answer = await readLastAnswer(host, invokedId);
    if (invoked.aborted) return abortedReport(invokedId, invoked.seat.role, answer);
    if (answer === undefined) return undefined;
    return { content: answer.text, requestId: `report:${invokedId}:${answer.entryId}` };
}

async function changeMeta(host: HarnessHost, conversationId: string, change: (meta: ConversationMeta) => void) {
    await internalHarness(host).commit(async (tx) => {
        change((await tx.doc(conversationMetaDoc, toConversationId(conversationId))) as ConversationMeta);
    }, context);
}

const withoutId = (ids: string[], id: string): string[] => ids.filter((candidate) => candidate !== id);

// One commit moves an earlier report into `held` and out of `awaiting`, so a crash never loses or repeats it.
async function holdReport(
    host: HarnessHost,
    input: { invokerId: string; invokedId: string; role: string; report: Report },
) {
    const { invokerId, invokedId, role, report } = input;
    const actor: SeatActor = { kind: "agent", conversationId: invokedId, role };
    await changeMeta(host, invokerId, (meta) => {
        if (!meta.held.some((message) => message.requestId === report.requestId)) {
            meta.held.push({
                content: report.content,
                mode: "followUp",
                kind: REPORT_KIND,
                actor,
                requestId: report.requestId,
            });
        }
        meta.awaiting = withoutId(meta.awaiting, invokedId);
    });
}

// The invoker's own writes run in its job's section, which orders them with a close; a close that wins leaves them
// undone, and `submitInput` after them takes its own section, so none is held across it.
async function deliver(host: HarnessHost, invokedId: string): Promise<void> {
    try {
        await deliverInSection(host, invokedId);
    } catch (error) {
        if (error instanceof ConversationClosedError) return;
        throw error;
    }
}

async function deliverInSection(host: HarnessHost, invokedId: string): Promise<void> {
    const invoked = await readConversationMeta(host, invokedId);
    if (invoked?.invokedBy === undefined || invoked.parked !== null) return;
    // A run that ends while the agent still waits for reports of agents it invoked doesn't end its part.
    if (invoked.awaiting.length > 0) return;
    const invokerId = invoked.invokedBy;
    const invoker = await readConversationMeta(host, invokerId);
    if (invoker === undefined || !invoker.awaiting.includes(invokedId)) return;
    // A closed invoker takes no report, and a close that failed leaves its state to repair rule 4 (ADR-001).
    if (await isConversationClosed(host, invokerId)) return;
    if ((await host.conversationInfo(invokedId))?.busy !== false) return;
    const report = await readReport(host, invoked, invokedId);
    if (report === undefined) return;

    const isLastReport = withoutId(invoker.awaiting, invokedId).length === 0;
    if (invoker.parked?.continueOn === "all" && !isLastReport) {
        await inOpenConversation(host, invokerId, () =>
            holdReport(host, { invokerId, invokedId, role: invoked.seat.role, report }),
        );
        return;
    }
    const actor: SeatActor = { kind: "agent", conversationId: invokedId, role: invoked.seat.role };
    const record: ReportRecord = { actor, content: report.content };
    const input = { ...report, entry: { kind: REPORT_KIND, data: record } };
    if (invoker.parked !== null || invoker.held.length > 0) {
        await continueParked(host, invokerId, input, (work) => inOpenConversation(host, invokerId, work));
    } else {
        await submitInput(host, invokerId, { ...input, busyMode: "followUp" });
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
    // An aborted idle or parked conversation has no run to end, so the commit that marks it starts its delivery.
    const watchMarks = await watchConversationMeta(host, ({ conversationId, meta }) => {
        if (meta.aborted && meta.invokedBy !== undefined) enqueue(conversationId);
    });
    for (const { id, busy } of watch.snapshot.conversations) {
        if (!busy) enqueue(id);
    }
    return {
        stop() {
            isStopped = true;
            watch.stop();
            watchMarks.stop();
        },
    };
}
