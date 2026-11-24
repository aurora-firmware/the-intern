/**
 * A conversation that waits for a model (ADR-014): the run end that records the wait with its notice, and the release
 * of a conversation that waited, a run that starts with no new input and continues from the transcript, which already
 * holds the input a `no_model` run placed.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type CommitChange,
    type ConversationId,
    type Cursor,
    defineEntry,
    GenerationTask,
    LiveDoc,
    type Tx,
} from "@earendil-works/pi-durable";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { inOpenConversation } from "./job_section.ts";
import { type ConversationMeta, conversationMetaDoc, readConversationMeta } from "./seating.ts";

const context = BACKGROUND_CONTEXT;

/** The display-only entry of the no-model notice: it carries no model message, so the model never sees it. */
export const NOTICE_KIND = "intern.notice";
export type NoticeRecord = { notice: "no_default_model"; text: string };
const noticeEntry = defineEntry<NoticeRecord>(NOTICE_KIND);

const NOTICE_TEXT =
    "There is no default model: pi agent's settings name none. This conversation waits and runs once a model is available.";
// The text pi-durable 1.4.0 gives a run whose agent has no model (`failNoModel` in `harness/generation.js`); a model it
// names but the registry lacks reads "Model ... is not available". Both fail with `detail.reason: "no_model"`, so the
// text is the only way to tell them apart. Each pi-durable upgrade rechecks it.
const ASSISTANT_KIND = "pi.assistant";
const NO_MODEL_CONFIGURED_MESSAGE = "No model is configured";
const GENERATION_KIND = GenerationTask.definition.name;

const ENTRY_SCAN_PAGE_SIZE = 50;

// The id of the period's first waiting entry: the oldest entry that carries model messages after the newest assistant
// entry and the newest notice, found by a descending scan. A table read must come before the commit's first table write.
async function firstWaitingEntryId(tx: Tx, conversationId: ConversationId): Promise<string | undefined> {
    let first: string | undefined;
    let cursor: Cursor | undefined;
    do {
        const page = await tx.scanEntries({ conversationId, order: "descending" }, ENTRY_SCAN_PAGE_SIZE, cursor);
        for (const entry of page.items) {
            if (entry.kind === ASSISTANT_KIND || entry.kind === NOTICE_KIND) return first;
            if ((entry.model?.length ?? 0) > 0) first = String(entry.id);
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return first;
}

/**
 * Marks the conversation as waiting for a model in the caller's host commit, with the notice, unless the fact is
 * already set: a waiting period gets one notice. `order` is read from the transcript in the same commit (ADR-014
 * decision 2): the id of the first entry the model sees after the newest assistant entry and notice, or the notice's own
 * id when there is none.
 */
export async function markWaiting(
    tx: Tx,
    conversationId: string,
    compaction?: { instructions?: string },
): Promise<void> {
    const id = toConversationId(conversationId);
    const meta = (await tx.doc(conversationMetaDoc, id)) as ConversationMeta;
    if (meta.waitingForModel !== undefined) return;
    const order = await firstWaitingEntryId(tx, id);
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

/**
 * Whether the conversation's newest terminal generation failed with `no_model`: its run end is no turn end, because the
 * agent never ran (ADR-014 decision 2). A conversation with no generation, or one that ended another way, is `false`.
 */
export async function endedWithNoModel(host: HarnessHost, conversationId: string): Promise<boolean> {
    const run = await newestGeneration(host, conversationId);
    return run !== undefined && failureOf(run).reason === "no_model";
}

/**
 * Handles the end of a run in the run-end queue (ADR-014 decision 2). Returns `true` when the conversation's run ended
 * with `no_model`, which delivers no report. A seat that has a model now continues at once, and a seat that names a
 * model the registry doesn't resolve stays failed. A seat with no model sets the waiting fact and the notice in one
 * commit, unless the fact is set.
 */
export async function handleNoModelEnd(host: HarnessHost, conversationId: string): Promise<boolean> {
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
    await internalHarness(host).commit((tx) => markWaiting(tx, conversationId), context);
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
        return startRunWhenIdle(tx, id, live);
    }, context);
}

// The caller read `live` before any table write. Creates the run unless one is active.
async function startRunWhenIdle(tx: Tx, id: ConversationId, live: { run?: unknown }): Promise<boolean> {
    if (live.run !== undefined) return false;
    const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: id });
    live.run = { taskId, inputs: [] };
    return true;
}

// Runs the compaction a waiting conversation needs, and waits for it. The task is created in the job section and
// awaited outside it, as a team member's compaction is, so the wait never holds the section.
async function runPendingCompaction(host: HarnessHost, conversationId: string): Promise<void> {
    const taskId = await inOpenConversation(host, conversationId, async () => {
        const meta = await readConversationMeta(host, conversationId);
        const compaction = meta?.waitingForModel?.compaction;
        if (meta === undefined || meta.seat.model === null || compaction === undefined) return undefined;
        const conversation = await internalHarness(host).conversation(toConversationId(conversationId), context);
        return conversation?.compact(compaction.instructions, context);
    });
    if (taskId !== undefined) await internalHarness(host).waitForTask(taskId, context);
}

/**
 * Releases a conversation that waited for a model (ADR-014 decision 4). It does nothing unless the conversation has the
 * waiting fact and its seat has a model. It runs a pending compaction and waits for it, then one host commit starts the
 * run with no input and clears the fact. When a run is already active, that run reads the same transcript, so the
 * commit only clears the fact. It runs inside `inOpenConversation`, so a closed conversation is never released: that
 * throws `ConversationClosedError`.
 */
export async function releaseWaiting(host: HarnessHost, conversationId: string): Promise<void> {
    await runPendingCompaction(host, conversationId);
    const id = toConversationId(conversationId);
    await inOpenConversation(host, conversationId, () =>
        internalHarness(host).commit(async (tx) => {
            const live = await tx.doc(LiveDoc, id);
            const meta = (await tx.doc(conversationMetaDoc, id)) as ConversationMeta;
            if (meta.waitingForModel === undefined || meta.seat.model === null) return;
            await startRunWhenIdle(tx, id, live);
            delete meta.waitingForModel;
        }, context),
    );
}
