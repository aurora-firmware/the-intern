/**
 * Host-side conversation input and control (S-002 REQ-012, REQ-013). Only `src/host/` calls pi-durable, so the service
 * layer reaches submit, abort, reset and compact through these functions.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type Conversation,
    ConversationBusy,
    type ConversationId,
    type InputEntry,
    type Submission,
    type SubmissionId,
    type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { type HarnessHost, internalHarness } from "./harness_host.ts";

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

/** The entry an input is placed as instead of `pi.user`; its model message is still the input's user message. */
export type InputRecord = { kind: string; data: unknown };

/** Submits input. The request id deduplicates: a known request id returns its existing submission. */
export async function submitInput(
    host: HarnessHost,
    conversationId: string,
    input: { content: string; requestId: string; busyMode: BusyMode; entry?: InputRecord },
): Promise<{ submissionId: string }> {
    const conversation = await requireConversation(host, conversationId);
    try {
        const submission = await conversation.submit(
            {
                type: "input",
                content: input.content,
                requestId: input.requestId,
                whenBusy: input.busyMode,
                ...(input.entry !== undefined && { entry: input.entry as InputEntry }),
            },
            context,
        );
        return { submissionId: String(submission.id) };
    } catch (error) {
        if (error instanceof ConversationBusy) throw new HostBusyError(conversationId, { cause: error });
        throw error;
    }
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
