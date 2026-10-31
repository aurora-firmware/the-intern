/**
 * Host-side conversation input and control (S-002 R-12, R-13). Only `src/host/` calls pi-durable, so the service layer
 * reaches submit, abort, reset and compact through these functions.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, ConversationBusy, type ConversationId } from "@earendil-works/pi-durable";
import { type HarnessHost, internalHarness } from "./harness_host.ts";

const context = BACKGROUND_CONTEXT;

export type BusyMode = "followUp" | "steer" | "reject";

export class HostBusyError extends Error {
    constructor(conversationId: string, options?: ErrorOptions) {
        super(`Conversation "${conversationId}" is busy and the input asked to be rejected when busy.`, options);
        this.name = "HostBusyError";
    }
}

async function requireConversation(host: HarnessHost, id: string): Promise<Conversation> {
    const conversationId = /^\d+$/.test(id) ? (Number(id) as ConversationId) : undefined;
    const conversation =
        conversationId === undefined ? undefined : await internalHarness(host).conversation(conversationId, context);
    if (!conversation) throw new HostNotFoundError(`Conversation "${id}" does not exist.`);
    return conversation;
}

export class HostNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostNotFoundError";
    }
}

/** Submits input. The request id deduplicates: a known request id returns its existing submission. */
export async function submitInput(
    host: HarnessHost,
    conversationId: string,
    input: { content: string; requestId: string; busyMode: BusyMode },
): Promise<{ submissionId: string }> {
    const conversation = await requireConversation(host, conversationId);
    try {
        const submission = await conversation.submit(
            { type: "input", content: input.content, requestId: input.requestId, whenBusy: input.busyMode },
            context,
        );
        return { submissionId: String(submission.id) };
    } catch (error) {
        if (error instanceof ConversationBusy) throw new HostBusyError(conversationId, { cause: error });
        throw error;
    }
}
