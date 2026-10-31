import { createHash } from "node:crypto";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
    type JsonObject,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

export type FakeTranscript = readonly { role: "user" | "assistant" | "toolResult"; text: string }[];

export type FakeReply = string | { toolCall: { name: string; arguments: Record<string, unknown> } };

export type FakeModelOptions = { delayMs?: (transcript: FakeTranscript) => number };

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function toFakeTranscript(context: TranscriptContext): FakeTranscript {
    return context.messages.flatMap((message) =>
        message.role === "system" ? [] : [{ role: message.role, text: textOf(message.content) }],
    );
}

function waitUnlessAborted(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (delayMs <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal?.addEventListener("abort", finish, { once: true });
    });
}

// pi-ai picks a random tool-call id, which would make a restarted run see a different step for the same transcript.
function toolCallIdFor(transcript: FakeTranscript, toolCall: { name: string; arguments: unknown }): string {
    const digest = createHash("sha256")
        .update(JSON.stringify([transcript, toolCall]))
        .digest("hex");
    return `tool-${digest.slice(0, 16)}`;
}

function messageFor(reply: FakeReply, transcript: FakeTranscript) {
    if (typeof reply === "string") return fauxAssistantMessage(reply);
    const { name, arguments: toolArguments } = reply.toolCall;
    const id = toolCallIdFor(transcript, reply.toolCall);
    return fauxAssistantMessage([fauxToolCall(name, toolArguments as JsonObject, { id })], { stopReason: "toolUse" });
}

/**
 * Registers a pi-ai faux model whose answer is the pure function `reply` of the transcript it receives.
 *
 * The default faux provider hands out queued answers, so a restarted run would get a different one. Here the single
 * queued step re-appends itself on every call, which makes the answer depend only on the transcript.
 *
 * `delayMs` holds the answer back; an abort ends the wait at once and the faux stream then reports the response as
 * aborted.
 */
export function createFakeModel(
    reply: (transcript: FakeTranscript) => FakeReply,
    options: FakeModelOptions = {},
): FauxProviderRegistration {
    const registration = registerFauxProvider();
    const answerFromTranscript: FauxResponseFactory = async (context, streamOptions) => {
        registration.appendResponses([answerFromTranscript]);
        const transcript = toFakeTranscript(context);
        await waitUnlessAborted(options.delayMs?.(transcript) ?? 0, streamOptions?.signal);
        return messageFor(reply(transcript), transcript);
    };
    registration.setResponses([answerFromTranscript]);
    return registration;
}
