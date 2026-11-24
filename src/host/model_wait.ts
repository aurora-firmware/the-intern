/**
 * A conversation that waits for a model (ADR-014): the run end that records the wait with its notice, and the release
 * of a conversation that waited, a run that starts with no new input and continues from the transcript, which already
 * holds the input a `no_model` run placed.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CommitChange, defineEntry, GenerationTask, LiveDoc, type Tx } from "@earendil-works/pi-durable";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { type ConversationMeta, conversationMetaDoc, readConversationMeta } from "./seating.ts";

const context = BACKGROUND_CONTEXT;

/** The display-only entry of the no-model notice: it carries no model message, so the model never sees it. */
export const NOTICE_KIND = "intern.notice";
export type NoticeRecord = { notice: "no_default_model"; text: string };
const noticeEntry = defineEntry<NoticeRecord>(NOTICE_KIND);

const NOTICE_TEXT =
    "There is no default model: pi agent's settings name none. This conversation waits and runs once a model is available.";
// pi-durable's text for a run whose agent has no model; a model it names but the registry lacks reads "... is not available".
const NO_MODEL_CONFIGURED_MESSAGE = "No model is configured";
const GENERATION_KIND = GenerationTask.definition.name;

/**
 * Marks the conversation as waiting for a model in the caller's host commit, with the notice, unless the fact is
 * already set: a waiting period gets one notice. `order` is the id of the period's first waiting input submission;
 * without one it is the notice's entry id.
 */
export async function markWaiting(
    tx: Tx,
    conversationId: string,
    compaction?: { instructions?: string },
    order?: string,
): Promise<void> {
    const id = toConversationId(conversationId);
    const meta = (await tx.doc(conversationMetaDoc, id)) as ConversationMeta;
    if (meta.waitingForModel !== undefined) return;
    const notice = await tx.appendEntry(noticeEntry, id, {
        data: { notice: "no_default_model", text: NOTICE_TEXT },
    });
    meta.waitingForModel = {
        order: order ?? String(notice.id),
        ...(compaction !== undefined && { compaction: JSON.parse(JSON.stringify(compaction)) }),
    };
}

type CommittedTask = Extract<CommitChange, { type: "task" }>["value"];

function failureOf(task: CommittedTask): { reason?: string; message?: string } {
    const { state } = task;
    if (state.status !== "terminal" || state.outcome.status !== "failed") return {};
    const { error } = state.outcome;
    return { reason: (error?.detail as { reason?: string } | undefined)?.reason, message: error?.message };
}

// The newest generation of the conversation.
async function newestGeneration(host: HarnessHost, conversationId: string) {
    const page = await internalHarness(host).commit(
        (tx) =>
            tx.scanTasks(
                {
                    conversationId: toConversationId(conversationId),
                    kind: GENERATION_KIND,
                    status: "terminal",
                    order: "descending",
                },
                1,
            ),
        context,
    );
    return page.items[0];
}

const smallestId = (ids: readonly string[]): string | undefined =>
    ids.reduce<string | undefined>(
        (smallest, id) => (smallest === undefined || Number(id) < Number(smallest) ? id : smallest),
        undefined,
    );

/**
 * Hears each run that ends with `no_model` and the input submissions that commit settled for it: pi-durable settles
 * them in the commit that ends the run, and `handleNoModelEnd` reads them back only here, since a settled submission
 * can't be read by conversation. Only commits after the call are heard.
 */
export function watchNoModelEnds(
    host: HarnessHost,
    listener: (end: { conversationId: string; inputIds: string[] }) => void,
): { stop(): void } {
    let isStopped = false;
    const unsubscribe = internalHarness(host).subscribeCommits((publication) => {
        if (isStopped) return;
        const ended = new Set<string>();
        const inputs = new Map<string, string[]>();
        for (const change of publication.changes) {
            if (change.type === "task" && change.value.kind === GENERATION_KIND) {
                if (failureOf(change.value).reason === "no_model") ended.add(String(change.value.conversationId));
            } else if (change.type === "submission") {
                const { value } = change;
                if (value.type !== "input" || value.status !== "unanswered" || value.reason !== "no_model") continue;
                const key = String(value.conversationId);
                inputs.set(key, [...(inputs.get(key) ?? []), String(value.id)]);
            }
        }
        for (const conversationId of ended) listener({ conversationId, inputIds: inputs.get(conversationId) ?? [] });
    });
    return {
        stop() {
            isStopped = true;
            unsubscribe();
        },
    };
}

/**
 * Handles the end of a run in the run-end queue (ADR-014 decision 2). Returns `true` when the conversation's run ended
 * with `no_model`, which delivers no report. A seat that has a model now continues at once, and a seat that names a
 * model the registry doesn't resolve stays failed. A seat with no model sets the waiting fact and the notice in one
 * commit, unless the fact is set. `inputIds` are the input submissions the run's end settled, from `watchNoModelEnds`.
 */
export async function handleNoModelEnd(
    host: HarnessHost,
    conversationId: string,
    inputIds: readonly string[] = [],
): Promise<boolean> {
    const run = await newestGeneration(host, conversationId);
    if (run === undefined) return false;
    const { reason, message } = failureOf(run);
    if (reason !== "no_model") return false;
    const meta = await readConversationMeta(host, conversationId);
    if (meta === undefined) return true;
    if (meta.seat.model !== null) {
        if (message === NO_MODEL_CONFIGURED_MESSAGE) await startRunWithoutInput(host, conversationId);
        return true;
    }
    const order = smallestId(inputIds);
    await internalHarness(host).commit((tx) => markWaiting(tx, conversationId, undefined, order), context);
    return true;
}

/**
 * Starts a run for the conversation with no input, in one host commit. Returns `false` and changes nothing when a run
 * is already active. It copies `startRun` of pi-durable 1.4.0 (`harness/generation.js`): a `pi.generation` task owned
 * by the conversation, taken as `pi.live.run` with no inputs (it leaves out the `submissionIds` telemetry, which has
 * nothing to list). It is written against that version, and each pi-durable
 * upgrade rechecks it (ADR-014 Consequences). When pi-durable offers a run start without input, use that instead.
 */
export async function startRunWithoutInput(host: HarnessHost, conversationId: string): Promise<boolean> {
    const id = toConversationId(conversationId);
    return internalHarness(host).commit(async (tx) => {
        const live = await tx.doc(LiveDoc, id);
        if (live.run !== undefined) return false;
        const taskId = await tx.createTask(
            GenerationTask,
            {},
            { ownership: { kind: "conversation" }, conversationId: id },
        );
        live.run = { taskId, inputs: [] };
        return true;
    }, context);
}
