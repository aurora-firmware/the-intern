import { createHash } from "node:crypto";
import {
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
    type JsonObject,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
    getApiProvider,
    registerApiProvider,
    registerFauxProvider,
    unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";

export type FakeTranscript = readonly { role: "user" | "assistant" | "toolResult"; text: string }[];

export type FakeReply = string | { toolCall: { name: string; arguments: Record<string, unknown> } };

export type FakeModelOptions = {
    delayMs?: (transcript: FakeTranscript) => number;
    /** Called with the transcript of each model request as it starts, before any delay or gate. */
    onRequest?: (transcript: FakeTranscript) => void;
    /** An answer waits until this promise settles (or the run is aborted), for a test that decides when a run ends. */
    gate?: Promise<void>;
    /**
     * An answer streams its first piece of text, then waits until this promise settles (or the run is aborted) before it
     * streams the rest, so a test can look at a partial answer while the turn is still running.
     */
    streamGate?: Promise<void>;
};

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

function untilOrAborted(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = (): void => {
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        void gate.then(finish);
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
 * The faux stream changes the text blocks of its earlier partials as it goes on and runs ahead of its consumer, so a
 * partial read late holds text the stream hadn't produced yet at that event. This rebuilds the text each partial held.
 */
function withTextSoFar(event: AssistantMessageEvent, textByBlock: string[]): AssistantMessageEvent {
    if (event.type !== "text_start" && event.type !== "text_delta" && event.type !== "text_end") return event;
    const content = event.partial.content.map((block, index) =>
        block.type === "text" ? { ...block, text: textByBlock[index] ?? "" } : block,
    );
    return { ...event, partial: { ...event.partial, content } };
}

/** Forwards the events of the source, pausing after its first text piece until the gate settles or the run aborts. */
async function forwardWithPause(
    source: AssistantMessageEventStream,
    target: AssistantMessageEventStream,
    gate: Promise<void>,
    signal: AbortSignal | undefined,
): Promise<void> {
    const textByBlock: string[] = [];
    let isPaused = false;
    for await (const event of source) {
        if (event.type === "text_start") textByBlock[event.contentIndex] = "";
        if (event.type === "text_delta") textByBlock[event.contentIndex] += event.delta;
        target.push(withTextSoFar(event, textByBlock));
        if (event.type !== "text_delta" || isPaused) continue;
        isPaused = true;
        await untilOrAborted(gate, signal);
    }
    target.end(await source.result());
}

/** Replaces the registration's api provider with one whose streams pause after their first text piece. */
function pauseStreamsAfterFirstText(registration: FauxProviderRegistration, gate: Promise<void>): () => void {
    const inner = getApiProvider(registration.api);
    if (!inner) throw new Error("The fake model's api is not registered");
    const sourceId = `paused-stream-${registration.api}`;
    const pausing =
        (stream: typeof inner.stream): typeof inner.stream =>
        (model, context, options) => {
            const target = createAssistantMessageEventStream();
            void forwardWithPause(stream(model, context, options), target, gate, options?.signal);
            return target;
        };
    registerApiProvider(
        { api: registration.api, stream: pausing(inner.stream), streamSimple: pausing(inner.streamSimple) },
        sourceId,
    );
    return () => unregisterApiProviders(sourceId);
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
        options.onRequest?.(transcript);
        await waitUnlessAborted(options.delayMs?.(transcript) ?? 0, streamOptions?.signal);
        if (options.gate) await untilOrAborted(options.gate, streamOptions?.signal);
        return messageFor(reply(transcript), transcript);
    };
    registration.setResponses([answerFromTranscript]);
    if (options.streamGate === undefined) return registration;
    const unregisterPause = pauseStreamsAfterFirstText(registration, options.streamGate);
    return {
        ...registration,
        unregister() {
            unregisterPause();
            registration.unregister();
        },
    };
}
