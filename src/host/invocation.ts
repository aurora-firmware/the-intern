/**
 * Invoked conversations (S-001 REQ-008, REQ-009, REQ-014, REQ-017): an agent invokes agents for parts of its job, and a
 * conversation can park until input arrives. The creation commit forks or creates the conversation, writes its whole
 * `intern.conversation` document and adds its id to the invoking conversation's `awaiting`, so a crash never leaves an
 * invoked conversation without its invocation link.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, InboxDoc, LiveDoc, type Tx } from "@earendil-works/pi-durable";
import { INVOCATION_DEPTH_CAP } from "../daemon/constants.ts";
import { FRONT_DESK_CREATION } from "../desk/desk_model.ts";
import type { Seat } from "../roles/role_model.ts";
import {
    abortConversation,
    compactConversation,
    type InputRecord,
    submissionIdFor,
    submitInput,
} from "./conversation_control.ts";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { findCreatedConversation } from "./idempotency.ts";
import { inJobSection, inOpenConversation } from "./job_section.ts";
import {
    type ContextMode,
    type ConversationMeta,
    conversationMetaDoc,
    type HeldMessage,
    type ParkedState,
    readConversationMeta,
    SEAT_RECORD_KIND,
    type SeatActor,
    SeatingError,
    seatWrites,
} from "./seating.ts";
import { STEER_RECORD_KIND } from "./steering.ts";

const context = BACKGROUND_CONTEXT;
const COMPACTION_ENTRY_KIND = "pi.compaction";
const ENTRY_PAGE_SIZE = 500;

export type InvocationRequest = { seat: Seat; contextMode: ContextMode; jobPrompt: string };

/** The front desk has no job, so no job's conversations include it (S-001 REQ-025). */
export class FrontDeskNotJobError extends Error {
    constructor(conversationId: string) {
        super(`The front desk (${conversationId}) is not a job conversation`);
        this.name = "FrontDeskNotJobError";
    }
}

export class InvocationDepthError extends Error {
    readonly cap: number;

    constructor(invokingId: string, depth: number, cap: number) {
        super(`Conversation "${invokingId}" is at depth ${depth}; an invocation past the cap of ${cap} is refused.`);
        this.name = "InvocationDepthError";
        this.cap = cap;
    }
}

// Maps an invocation request id to the conversation it created, written in the commit that creates the conversation.
// Not `intern.idempotency`: that record is written by `createConversationOnce`, which creates conversations but
// cannot fork one, and a fork needs the key written in the same commit as the fork.
const invocationsDocument = defineDoc<{ conversations: Record<string, string> }>({
    kind: "intern.invocations",
    version: 1,
    scope: "session",
    initial: () => ({ conversations: {} }),
    checkpointWhen: () => false,
});

// One invocation call at a time per host, so concurrent calls with one request id can't both miss the lookup.
const pendingInvocations = new WeakMap<HarnessHost, Promise<unknown>>();

const requestIdOf = (invokingId: string, callId: string, index: number): string =>
    `invoke:${invokingId}:${callId}:${index}`;

async function requireMeta(host: HarnessHost, conversationId: string): Promise<ConversationMeta> {
    const meta = await readConversationMeta(host, conversationId);
    if (meta === undefined) {
        throw new SeatingError(`Conversation "${conversationId}" was not created by createSeatedConversation.`);
    }
    return meta;
}

async function createOne(
    tx: Tx,
    input: {
        invoking: { jobId: string | null; depth: number };
        invokingId: string;
        request: InvocationRequest;
        actor: SeatActor;
    },
    forkAt: Awaited<ReturnType<Tx["scanEntries"]>>["items"][number] | undefined,
): Promise<string> {
    const { invoking, invokingId, request, actor } = input;
    const ownership = { kind: "ownerless" } as const;
    const isFork = request.contextMode !== "clean" && forkAt !== undefined;
    const record = isFork
        ? await tx.forkConversation(toConversationId(invokingId), forkAt.id, { ownership })
        : await tx.createConversation({ ownership });
    const conversationId = String(record.id);
    // Every field is written, so a fork keeps nothing of the invoker's document.
    const meta = await tx.doc(conversationMetaDoc, record.id);
    meta.jobId = invoking.jobId;
    meta.isLead = false;
    meta.origin = { kind: "invocation", conversationId: invokingId };
    meta.depth = invoking.depth + 1;
    meta.invokedBy = invokingId;
    meta.awaiting = [];
    meta.parked = null;
    meta.held = [];
    meta.aborted = false;
    await seatWrites(tx, conversationId, { seat: request.seat, actor });
    return conversationId;
}

async function createMissing(
    host: HarnessHost,
    input: { invokingId: string; callId: string; agents: InvocationRequest[]; actor: SeatActor; parked?: ParkedState },
): Promise<string[]> {
    const { invokingId, callId, agents, actor, parked } = input;
    return internalHarness(host).commit(async (tx) => {
        const invokingDoc = await tx.doc(conversationMetaDoc, toConversationId(invokingId));
        if (invokingDoc.jobId === "") {
            throw new SeatingError(`Conversation "${invokingId}" was not created by createSeatedConversation.`);
        }
        const invoking = { jobId: invokingDoc.jobId, depth: invokingDoc.depth };
        if (invoking.depth >= INVOCATION_DEPTH_CAP) {
            throw new InvocationDepthError(invokingId, invoking.depth, INVOCATION_DEPTH_CAP);
        }
        const recorded = await tx.doc(invocationsDocument);
        const hasMissing = agents.some(
            (_, index) => recorded.conversations[requestIdOf(invokingId, callId, index)] === undefined,
        );
        // Table reads come before the first table write.
        const latest = hasMissing
            ? (await tx.scanEntries({ conversationId: toConversationId(invokingId), order: "descending" }, 1)).items[0]
            : undefined;
        const ids: string[] = [];
        for (const [index, request] of agents.entries()) {
            const requestId = requestIdOf(invokingId, callId, index);
            const stored = recorded.conversations[requestId];
            if (stored !== undefined) {
                ids.push(stored);
                continue;
            }
            const conversationId = await createOne(tx, { invoking, invokingId, request, actor }, latest);
            recorded.conversations[requestId] = conversationId;
            invokingDoc.awaiting.push(conversationId);
            if (parked !== undefined) invokingDoc.parked = parked;
            ids.push(conversationId);
        }
        return ids;
    }, context);
}

async function hasSubmission(host: HarnessHost, conversationId: string, requestId: string): Promise<boolean> {
    const found = await internalHarness(host).commit(
        (tx) => tx.submissionByRequest(toConversationId(conversationId), requestId),
        context,
    );
    return found !== undefined;
}

// Whether the conversation holds a compaction made after its own seat record. A Compact conversation is a fork that
// copied the invoker's entries, `pi.compaction` ones included, and its seat record is written in the commit that forks
// it: only a compaction after that record is this invocation's. Read from the entries, so a restart doesn't lose it.
async function isCompactedSinceFork(host: HarnessHost, conversationId: string): Promise<boolean> {
    let isCompacted = false;
    let after: string | undefined;
    do {
        const page = await host.readEntries(conversationId, { limit: ENTRY_PAGE_SIZE, ...(after && { after }) });
        for (const entry of page.entries) {
            if (entry.kind === SEAT_RECORD_KIND) isCompacted = false;
            else if (entry.kind === COMPACTION_ENTRY_KIND) isCompacted = true;
        }
        after = page.next;
    } while (after !== undefined);
    return isCompacted;
}

// A Compact context is compacted with the job prompt as instructions before the prompt itself is submitted, unless a
// call before the crash already compacted it.
async function submitJobPrompt(
    host: HarnessHost,
    conversationId: string,
    request: InvocationRequest,
    requestId: string,
) {
    if (await hasSubmission(host, conversationId, requestId)) return;
    const isCompactNeeded = request.contextMode === "compact" && !(await isCompactedSinceFork(host, conversationId));
    if (isCompactNeeded) await compactConversation(host, conversationId, request.jobPrompt);
    await submitInput(host, conversationId, { content: request.jobPrompt, requestId, busyMode: "followUp" });
}

async function invoke(
    host: HarnessHost,
    input: { invokingId: string; callId: string; agents: InvocationRequest[]; actor: SeatActor; parked?: ParkedState },
): Promise<string[]> {
    const ids = await inOpenConversation(host, input.invokingId, () => createMissing(host, input));
    await Promise.all(
        ids.map((id, index) =>
            submitJobPrompt(
                host,
                id,
                input.agents[index] as InvocationRequest,
                requestIdOf(input.invokingId, input.callId, index),
            ),
        ),
    );
    return ids;
}

/**
 * Creates one conversation of the invoking conversation's job per request and submits each job prompt. A repeated
 * call with the same invoking id and call id returns the same conversations and creates nothing; it submits a job
 * prompt only when a crash left it unsubmitted.
 */
export async function createInvokedConversations(
    host: HarnessHost,
    input: { invokingId: string; callId: string; agents: InvocationRequest[]; actor: SeatActor; parked?: ParkedState },
): Promise<string[]> {
    const previous = pendingInvocations.get(host) ?? Promise.resolve();
    const result = previous.then(() => invoke(host, input));
    pendingInvocations.set(
        host,
        result.catch(() => undefined),
    );
    return result;
}

async function updateMeta(host: HarnessHost, conversationId: string, change: (meta: ConversationMeta) => void) {
    await requireMeta(host, conversationId);
    await internalHarness(host).commit(async (tx) => {
        change((await tx.doc(conversationMetaDoc, toConversationId(conversationId))) as ConversationMeta);
    }, context);
}

/** Marks the conversation parked: it keeps its state and waits for input. */
export async function parkConversation(host: HarnessHost, conversationId: string, parked: ParkedState): Promise<void> {
    await updateMeta(host, conversationId, (meta) => {
        meta.parked = parked;
    });
}

/** Clears the parked state without submitting anything, for a conversation that input already reached. */
export async function unparkConversation(host: HarnessHost, conversationId: string): Promise<void> {
    await updateMeta(host, conversationId, (meta) => {
        meta.parked = null;
    });
}

// A held message is placed as its own kind, so the transcript names its sender where it is delivered.
function heldEntryOf(message: HeldMessage): InputRecord {
    const { actor, mode, content } = message;
    if (message.kind !== undefined) return { kind: message.kind, data: { actor, content } };
    return { kind: STEER_RECORD_KIND, data: { actor, mode, content } };
}

// Clears the parked state, then submits the held messages in order, as the request ids make a repeat safe. The held
// list is cleared by the caller once everything that goes with it is submitted, so a crash in between loses none.
async function releaseHeld(host: HarnessHost, conversationId: string, inSection: InSection): Promise<void> {
    await inSection(() =>
        updateMeta(host, conversationId, (meta) => {
            meta.parked = null;
        }),
    );
    const held = (await requireMeta(host, conversationId)).held;
    for (const message of held) {
        await submitInput(host, conversationId, {
            content: message.content,
            requestId: message.requestId,
            busyMode: message.mode,
            entry: heldEntryOf(message),
        });
    }
}

/** Wraps the commit that clears the parked state, so a caller can order it in the conversation's job section. */
export type InSection = (work: () => Promise<void>) => Promise<void>;
const withoutSection: InSection = (work) => work();

const clearHeld = (host: HarnessHost, conversationId: string) =>
    updateMeta(host, conversationId, (meta) => {
        meta.held = [];
    });

/**
 * Clears the parked state, then submits the held messages in order and the input after them, as follow-ups: the first
 * starts a run on a free worker thread. The held messages are cleared only once submitted, so a crash in between
 * loses none; their request ids make a repeated call safe. A repeat of an input pi-durable already holds is no new
 * input, so it returns that submission and leaves the conversation parked. `inSection` runs the parked-clear commit,
 * and a refusal from it leaves the conversation as it was.
 */
export async function continueParked(
    host: HarnessHost,
    conversationId: string,
    input: { content: string; requestId: string; entry?: InputRecord },
    inSection: InSection = withoutSection,
): Promise<{ submissionId: string }> {
    const existing = await submissionIdFor(host, conversationId, input.requestId);
    if (existing !== undefined) return { submissionId: existing };
    await releaseHeld(host, conversationId, inSection);
    const submitted = await submitInput(host, conversationId, { ...input, busyMode: "followUp" });
    await clearHeld(host, conversationId);
    return submitted;
}

/** Continues a conversation that no new input reached: clears the parked state and delivers only its held messages. */
export async function continueWithHeld(host: HarnessHost, conversationId: string): Promise<void> {
    await releaseHeld(host, conversationId, withoutSection);
    await clearHeld(host, conversationId);
}

// One commit per conversation (ADR-001 decision 4): an aborted conversation is left neither parked nor waiting for
// a report, and its held messages are withdrawn as an abort withdraws queued input. The same commit marks a lone
// abort of an invoked conversation (`isReportOwed`), so its invoker is owed an "aborted" report.
async function clearWaiting(host: HarnessHost, conversationId: string, isReportOwed = false): Promise<void> {
    if ((await readConversationMeta(host, conversationId)) === undefined) return;
    await updateMeta(host, conversationId, (meta) => {
        meta.parked = null;
        meta.awaiting = [];
        meta.held = [];
        if (isReportOwed) meta.aborted = true;
    });
}

// The abort's root owes a report only when it was invoked and its invoker still awaits it.
async function isReportOwedTo(host: HarnessHost, meta: ConversationMeta | undefined, id: string): Promise<boolean> {
    if (meta?.invokedBy === undefined) return false;
    return (await readConversationMeta(host, meta.invokedBy))?.awaiting.includes(id) ?? false;
}

// Clears the conversation and, recursively, every conversation it awaits, and returns the ids in the order they are
// aborted. Nothing is aborted here: the caller does that after the job's section is released.
async function clearRecursively(
    host: HarnessHost,
    conversationId: string,
    cleared: Set<string>,
    isRoot = false,
): Promise<void> {
    if (cleared.has(conversationId)) return;
    // Read before clearing: the list is what the cascade follows. A conversation that was not seated has no
    // invocation links and awaits nothing.
    const meta = await readConversationMeta(host, conversationId);
    const isReportOwed = isRoot && (await isReportOwedTo(host, meta, conversationId));
    cleared.add(conversationId);
    // Cleared before any abort, so no cascaded run finds its invoker still waiting.
    await clearWaiting(host, conversationId, isReportOwed);
    for (const awaitedId of meta?.awaiting ?? []) await clearRecursively(host, awaitedId, cleared);
}

/**
 * Aborts the conversation, then every conversation it still awaits a report from, recursively, whether it is
 * steerable or parked. An invoked conversation that has reported has left `awaiting` and is not touched. No aborted
 * conversation stays parked, waits for a report or keeps held messages. A closed conversation is refused with
 * `ConversationClosedError`. The check and the clearing commits run in the job's section; the aborts wait for the
 * runs to end, so they run after the section is released.
 */
export async function abortWithAwaited(host: HarnessHost, conversationId: string): Promise<string[]> {
    const cleared = new Set<string>();
    await inOpenConversation(host, conversationId, () => clearRecursively(host, conversationId, cleared, true));
    const aborted = [...cleared];
    for (const id of aborted) await abortConversation(host, id);
    return aborted;
}

// The closed mark and the emptied inbox are one commit, so no queued item (a reset included) can land at a run's
// boundary after the mark. Held messages have no submission, so they settle nothing.
async function closeConversation(host: HarnessHost, conversationId: string): Promise<void> {
    await requireMeta(host, conversationId);
    const id = toConversationId(conversationId);
    await internalHarness(host).commit(async (tx) => {
        const meta = (await tx.doc(conversationMetaDoc, id)) as ConversationMeta;
        meta.closed = true;
        meta.parked = null;
        meta.awaiting = [];
        meta.held = [];
        const inbox = await tx.doc(InboxDoc, id);
        for (const item of inbox.items) tx.settleSubmission(item.id, { status: "unanswered", reason: "closed" });
        inbox.items = [];
    }, context);
}

// Lists and closes in the job's section, so no admission or creation of the job falls between the list and the marks.
export function closeJobConversations(host: HarnessHost, jobId: string): Promise<string[]> {
    return inJobSection(host, jobId, async () => {
        const ofJob: string[] = [];
        for (const { id } of await host.listConversations()) {
            if ((await readConversationMeta(host, id))?.jobId === jobId) ofJob.push(id);
        }
        for (const id of ofJob) await closeConversation(host, id);
        return ofJob;
    });
}

/**
 * Aborts the compactions still running in the conversations, the completing lead's included, now that their closed
 * marks are committed: a finished summary is placed outside the job's section and would follow the mark. A blocking
 * compaction is left to `Conversation.abort()`, because its generation owns it and would fail the run if it were
 * aborted alone. This runs before the first `Conversation.abort()`, which turns scheduling on after a restart, so no
 * compaction marked later can send a model request first. Without `onError` a failure rejects.
 */
export async function abortRunningCompactions(
    host: HarnessHost,
    conversationIds: string[],
    onError?: (error: unknown) => void,
): Promise<void> {
    const harness = internalHarness(host);
    for (const id of conversationIds) {
        try {
            const live = await harness.snapshot(LiveDoc, toConversationId(id), context);
            for (const status of live?.compactions ?? []) {
                if (!status.blocking) await harness.abortTask(status.taskId, context);
            }
        } catch (error) {
            if (onError === undefined) throw error;
            onError(error);
        }
    }
}

/**
 * Closes every conversation whose `intern.conversation` document names the job (closed mark set, nothing parked,
 * awaited or held) in the job's section, awaits `afterClosed`, then aborts them. The section is released before
 * `afterClosed` and the aborts. `own` names the conversation of a running tool: it is closed and not aborted, because
 * its abort would cut the tool's call off, and its run ends by itself when the tool returns. With `own`, a failed
 * abort of another conversation goes to `own.onError` and the remaining aborts are still attempted; without it the
 * failure rejects. A failed closed-mark commit rejects. No abort mark is set, so no report is sent.
 */
export async function abortJobConversations(
    host: HarnessHost,
    jobId: string,
    own?: { conversationId: string; onError(error: unknown): void },
    afterClosed?: () => void | Promise<void>,
): Promise<string[]> {
    if (jobId === (await findCreatedConversation(host, FRONT_DESK_CREATION))) throw new FrontDeskNotJobError(jobId);
    const ofJob = await closeJobConversations(host, jobId);
    await afterClosed?.();
    await abortRunningCompactions(host, ofJob, own?.onError);
    for (const id of ofJob) {
        if (id === own?.conversationId) continue;
        try {
            await abortConversation(host, id);
        } catch (error) {
            if (own === undefined) throw error;
            own.onError(error);
        }
    }
    return ofJob;
}

/**
 * Aborts the job's conversations after a failure while closing the job, so a queued input can't run a model turn on a
 * Done job. The compactions still running in the conversations whose closed mark landed are stopped first, the lead's
 * included, then the conversations are aborted in turn, and a failed stop or abort goes to `onError` without ending
 * the rest. A running tool's `ownConversationId` is aborted unless its closed mark landed, and that abort is not
 * awaited: it waits for the run, and the run waits for the tool call that is making this call. Without it every
 * conversation is aborted and awaited. The marks that did not land are not retried: repair rule 4 sets them, and
 * ends the compactions of those conversations, at the next start.
 */
export async function abortAfterFailedClose(
    host: HarnessHost,
    jobId: string,
    ownConversationId: string | undefined,
    onError: (error: unknown) => void,
): Promise<void> {
    // Listed in the job's section, so a conversation admitted before the abort is in the list.
    const ofJob = await inJobSection(host, jobId, async () => {
        const found: { id: string; isClosed: boolean }[] = [];
        for (const { id } of await host.listConversations()) {
            const meta = await readConversationMeta(host, id);
            if (meta?.jobId === jobId) found.push({ id, isClosed: meta.closed === true });
        }
        return found;
    });
    await abortRunningCompactions(
        host,
        ofJob.filter(({ isClosed }) => isClosed).map(({ id }) => id),
        onError,
    );
    for (const { id, isClosed } of ofJob) {
        if (id !== ownConversationId) {
            await abortConversation(host, id).catch(onError);
            continue;
        }
        if (!isClosed) void abortConversation(host, id).catch(onError);
    }
}
