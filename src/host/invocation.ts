/**
 * Invoked conversations (S-001 R-8, R-9, R-14, R-17): an agent invokes agents for parts of its job, and a conversation
 * can park until input arrives. The creation commit forks or creates the conversation, writes its whole
 * `intern.conversation` document and adds its id to the invoking conversation's `awaiting`, so a crash never leaves an
 * invoked conversation without its invocation link.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Tx } from "@earendil-works/pi-durable";
import { INVOCATION_DEPTH_CAP } from "../daemon/constants.ts";
import type { Seat } from "../roles/role_model.ts";
import { abortConversation, compactConversation, submitInput } from "./conversation_control.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import {
    type ContextMode,
    type ConversationMeta,
    conversationMetaDoc,
    type ParkedState,
    readConversationMeta,
    type SeatActor,
    SeatingError,
    seatWrites,
} from "./seating.ts";

const context = BACKGROUND_CONTEXT;

export type InvocationRequest = { seat: Seat; contextMode: ContextMode; jobPrompt: string };

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

const toNumericId = (conversationId: string): ConversationId => Number(conversationId) as ConversationId;
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
        invoking: { jobId: string; depth: number };
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
        ? await tx.forkConversation(toNumericId(invokingId), forkAt.id, { ownership })
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
        const invokingDoc = await tx.doc(conversationMetaDoc, toNumericId(invokingId));
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
            ? (await tx.scanEntries({ conversationId: toNumericId(invokingId), order: "descending" }, 1)).items[0]
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
        (tx) => tx.submissionByRequest(toNumericId(conversationId), requestId),
        context,
    );
    return found !== undefined;
}

// A Compact context is compacted with the job prompt as instructions before the prompt itself is submitted.
async function submitJobPrompt(
    host: HarnessHost,
    conversationId: string,
    request: InvocationRequest,
    requestId: string,
) {
    if (await hasSubmission(host, conversationId, requestId)) return;
    if (request.contextMode === "compact") await compactConversation(host, conversationId, request.jobPrompt);
    await submitInput(host, conversationId, { content: request.jobPrompt, requestId, busyMode: "followUp" });
}

async function invoke(
    host: HarnessHost,
    input: { invokingId: string; callId: string; agents: InvocationRequest[]; actor: SeatActor; parked?: ParkedState },
): Promise<string[]> {
    const ids = await createMissing(host, input);
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
        change((await tx.doc(conversationMetaDoc, toNumericId(conversationId))) as ConversationMeta);
    }, context);
}

/** Marks the conversation parked: it keeps its state and waits for input. */
export async function parkConversation(host: HarnessHost, conversationId: string, parked: ParkedState): Promise<void> {
    await updateMeta(host, conversationId, (meta) => {
        meta.parked = parked;
    });
}

/**
 * Clears the parked state, then submits the held messages in order and the input after them, as follow-ups: the first
 * starts a run on a free worker thread. The held messages are cleared only once submitted, so a crash in between
 * loses none; their request ids make a repeated call safe.
 */
export async function continueParked(
    host: HarnessHost,
    conversationId: string,
    input: { content: string; requestId: string },
): Promise<{ submissionId: string }> {
    await updateMeta(host, conversationId, (meta) => {
        meta.parked = null;
    });
    const held = (await requireMeta(host, conversationId)).held;
    for (const message of held) {
        await submitInput(host, conversationId, {
            content: message.content,
            requestId: message.requestId,
            busyMode: message.mode,
        });
    }
    const submitted = await submitInput(host, conversationId, { ...input, busyMode: "followUp" });
    await updateMeta(host, conversationId, (meta) => {
        meta.held = [];
    });
    return submitted;
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

async function abortRecursively(
    host: HarnessHost,
    conversationId: string,
    aborted: Set<string>,
    isRoot = false,
): Promise<void> {
    if (aborted.has(conversationId)) return;
    // Read before clearing: the list is what the cascade follows. A conversation that was not seated has no
    // invocation links and awaits nothing.
    const meta = await readConversationMeta(host, conversationId);
    const isReportOwed = isRoot && (await isReportOwedTo(host, meta, conversationId));
    aborted.add(conversationId);
    // Cleared before the abort and before the recursion, so no cascaded run finds its invoker still waiting.
    await clearWaiting(host, conversationId, isReportOwed);
    await abortConversation(host, conversationId);
    for (const awaitedId of meta?.awaiting ?? []) await abortRecursively(host, awaitedId, aborted);
}

/**
 * Aborts the conversation, then every conversation it still awaits a report from, recursively, whether it is
 * steerable or parked. An invoked conversation that has reported has left `awaiting` and is not touched. No aborted
 * conversation stays parked, waits for a report or keeps held messages.
 */
export async function abortWithAwaited(host: HarnessHost, conversationId: string): Promise<string[]> {
    const aborted = new Set<string>();
    await abortRecursively(host, conversationId, aborted, true);
    return [...aborted];
}

/** Aborts every conversation whose `intern.conversation` document names the job, clearing them all first. */
export async function abortJobConversations(host: HarnessHost, jobId: string): Promise<string[]> {
    const ofJob: string[] = [];
    for (const { id } of await host.listConversations()) {
        if ((await readConversationMeta(host, id))?.jobId === jobId) ofJob.push(id);
    }
    for (const id of ofJob) await clearWaiting(host, id);
    for (const id of ofJob) await abortConversation(host, id);
    return ofJob;
}
