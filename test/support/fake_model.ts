import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

export type FakeTranscript = readonly { role: "user" | "assistant" | "toolResult"; text: string }[];

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

/**
 * Registers a pi-ai faux model whose answer is the pure function `reply` of the transcript it receives.
 *
 * The default faux provider hands out queued answers, so a restarted run would get a different one. Here the single
 * queued step re-appends itself on every call, which makes the answer depend only on the transcript.
 */
export function createFakeModel(reply: (transcript: FakeTranscript) => string): FauxProviderRegistration {
    const registration = registerFauxProvider();
    const answerFromTranscript: FauxResponseFactory = (context) => {
        registration.appendResponses([answerFromTranscript]);
        return fauxAssistantMessage(reply(toFakeTranscript(context)));
    };
    registration.setResponses([answerFromTranscript]);
    return registration;
}
