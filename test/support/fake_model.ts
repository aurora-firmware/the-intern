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

function messageFor(reply: FakeReply) {
    if (typeof reply === "string") return fauxAssistantMessage(reply);
    const { name, arguments: toolArguments } = reply.toolCall;
    return fauxAssistantMessage([fauxToolCall(name, toolArguments as JsonObject)], { stopReason: "toolUse" });
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
        return messageFor(reply(transcript));
    };
    registration.setResponses([answerFromTranscript]);
    return registration;
}
