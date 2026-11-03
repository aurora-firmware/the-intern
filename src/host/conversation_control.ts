/**
 * Host-side conversation input and control (S-002 REQ-012, REQ-013). Only `src/host/` calls pi-durable, so the service
 * layer reaches submit, abort, reset and compact through these functions.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type Conversation,
    ConversationBusy,
    type ConversationId,
    InboxDoc,
    type InputEntry,
    type Submission,
    type SubmissionId,
    type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { inOpenConversation } from "./job_section.ts";

const context = BACKGROUND_CONTEXT;

export type BusyMode = "followUp" | "steer" | "reject";
export type SubmissionState = { state: "queued" | "running" | "done" | "unanswered"; reason?: string };

export class HostBusyError extends Error {
    constructor(conversationId: string, options?: ErrorOptions) {
        super(`Conversation "${conversationId}" is busy and the input asked to be rejected when busy.`, options);
        this.name = "HostBusyError";
    }
}

export class HostNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostNotFoundError";
    }
}

export class HostConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostConflictError";
    }
}

function parseNumericId(id: string): number | undefined {
    return /^\d+$/.test(id) ? Number(id) : undefined;
}

async function requireConversation(host: HarnessHost, id: string): Promise<Conversation> {
    const numericId = parseNumericId(id);
    const conversation =
        numericId === undefined
            ? undefined
            : await internalHarness(host).conversation(numericId as ConversationId, context);
    if (!conversation) throw new HostNotFoundError(`Conversation "${id}" does not exist.`);
    return conversation;
}

async function requireSubmission(host: HarnessHost, id: string): Promise<Submission> {
    const numericId = parseNumericId(id);
    const submission =
        numericId === undefined
            ? undefined
            : await internalHarness(host).submission(numericId as SubmissionId, context);
    if (!submission) throw new HostNotFoundError(`Submission "${id}" does not exist.`);
    return submission;
}

// pi-durable's "placed" is an input the active run owns, which the product reports as running.
function toSubmissionState(record: SubmissionRecord): SubmissionState {
    if (record.status === "placed") return { state: "running" };
    if (record.status === "unanswered") return { state: "unanswered", reason: record.reason };
    return { state: record.status };
}

export type SubmittedInput = { conversationId: string; requestId: string };
type InputListener = (input: SubmittedInput) => Promise<void>;

const inputListeners = new WeakMap<HarnessHost, InputListener[]>();

/**
 * Registers a listener that is awaited once pi-durable has admitted an input to a conversation, whether it was
 * submitted or steered. A held message calls nothing until it is delivered. Returns the function that removes it.
 */
export function onInputSubmitted(host: HarnessHost, listener: InputListener): () => void {
    const listeners = inputListeners.get(host) ?? [];
    listeners.push(listener);
    inputListeners.set(host, listeners);
    return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };
}

/** Awaits the listeners in registration order with an input that pi-durable has admitted. */
export async function notifyInputSubmitted(host: HarnessHost, input: SubmittedInput): Promise<void> {
    for (const listener of [...(inputListeners.get(host) ?? [])]) await listener(input);
}

/** The entry an input is placed as instead of `pi.user`; its model message is still the input's user message. */
export type InputRecord = { kind: string; data: unknown };

function findSubmission(host: HarnessHost, conversation: Conversation, requestId: string) {
    return internalHarness(host).commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
}

/**
 * The submission pi-durable holds for the request id, in any state, or `undefined`. A caller that finds one knows a
 * repeat of the input places nothing, so it changes nothing that only new input changes.
 */
export async function submissionIdFor(
    host: HarnessHost,
    conversationId: string,
    requestId: string,
): Promise<string | undefined> {
    const found = await findSubmission(host, await requireConversation(host, conversationId), requestId);
    return found === undefined ? undefined : String(found.id);
}

/**
 * Submits input. The request id deduplicates: a known request id returns its existing submission, places nothing and
 * calls no input listener, because no input reached the conversation.
 */
export async function submitInput(
    host: HarnessHost,
    conversationId: string,
    input: { content: string; requestId: string; busyMode: BusyMode; entry?: InputRecord },
): Promise<{ submissionId: string }> {
    const conversation = await requireConversation(host, conversationId);
    const isRepeat = (await findSubmission(host, conversation, input.requestId)) !== undefined;
    try {
        // The listeners run after the section is released: a listener may enter the job's section itself.
        const submission = await inOpenConversation(host, conversationId, () =>
            conversation.submit(
                {
                    type: "input",
                    content: input.content,
                    requestId: input.requestId,
                    whenBusy: input.busyMode,
                    ...(input.entry !== undefined && { entry: input.entry as InputEntry }),
                },
                context,
            ),
        );
        if (!isRepeat) await notifyInputSubmitted(host, { conversationId, requestId: input.requestId });
        return { submissionId: String(submission.id) };
    } catch (error) {
        if (error instanceof ConversationBusy) throw new HostBusyError(conversationId, { cause: error });
        throw error;
    }
}

/** Whether pi-durable holds a submission of the conversation with this request id, in any state. */
export async function hasSubmissionWithRequestId(
    host: HarnessHost,
    conversationId: string,
    requestId: string,
): Promise<boolean> {
    return (await submissionIdFor(host, conversationId, requestId)) !== undefined;
}

/** Whether the conversation has input or writes queued in its inbox for the next boundary. */
export async function hasQueuedInput(host: HarnessHost, conversationId: string): Promise<boolean> {
    const conversation = await requireConversation(host, conversationId);
    const inbox = await internalHarness(host).snapshot(InboxDoc, conversation.id, context);
    return (inbox?.items.length ?? 0) > 0;
}

// The kinds a transcript places an input as: plain `pi.user`, and the kinds ADR-004 gives inputs sent on behalf.
const INPUT_ENTRY_KINDS: ReadonlySet<string> = new Set(["pi.user", "intern.steer", "intern.report"]);
const SCAN_PAGE_SIZE = 20;

/**
 * Whether the conversation took an input after the entry `afterEntryId`: an input entry newer than it in the
 * transcript. The entries are read newest first and the scan stops at that entry.
 */
export async function hasInputSince(host: HarnessHost, conversationId: string, afterEntryId: string): Promise<boolean> {
    const conversation = await requireConversation(host, conversationId);
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    do {
        const page = await conversation.entries({ order: "descending" }, SCAN_PAGE_SIZE, cursor, context);
        for (const entry of page.items) {
            if (String(entry.id) === afterEntryId) return false;
            if (INPUT_ENTRY_KINDS.has(entry.kind)) return true;
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return false;
}

/** Withdraws a queued input, which settles `unanswered`. Input already placed in the transcript cannot be withdrawn. */
export async function withdrawInput(host: HarnessHost, submissionId: string): Promise<void> {
    const submission = await requireSubmission(host, submissionId);
    const result = await submission.abort(context);
    if (result === "already_placed") {
        throw new HostConflictError(`Submission "${submissionId}" is already placed in the transcript.`);
    }
}

export async function submissionState(host: HarnessHost, submissionId: string): Promise<SubmissionState> {
    const submission = await requireSubmission(host, submissionId);
    return toSubmissionState(await submission.status(context));
}

/** Waits until the submission settles, or returns its current state at `timeoutMs`. A timeout is not an error. */
export async function waitForSubmission(
    host: HarnessHost,
    submissionId: string,
    timeoutMs: number,
): Promise<SubmissionState> {
    const submission = await requireSubmission(host, submissionId);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
        const settled = await Promise.race([submission.wait(context), timedOut]);
        if (settled !== "timeout") return toSubmissionState(settled);
        return toSubmissionState(await submission.status(context));
    } finally {
        clearTimeout(timer);
    }
}

export async function abortConversation(host: HarnessHost, conversationId: string): Promise<void> {
    await (await requireConversation(host, conversationId)).abort(context);
}

export async function resetConversation(host: HarnessHost, conversationId: string, note?: string): Promise<void> {
    await (await requireConversation(host, conversationId)).reset(note, context);
}

export async function compactConversation(
    host: HarnessHost,
    conversationId: string,
    instructions?: string,
): Promise<void> {
    const conversation = await requireConversation(host, conversationId);
    const taskId = await conversation.compact(instructions, context);
    await internalHarness(host).waitForTask(taskId, context);
}
