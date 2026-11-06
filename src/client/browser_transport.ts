/**
 * The client library's browser transport (S-003 REQ-009, AC-009.3): calls and feed streams to a base URL over the
 * browser's own `fetch`, in the format the Node transport uses. It imports only the shared client module, so it runs
 * in a browser (REQ-013).
 */
import {
    answerError,
    encodeInput,
    JSON_CONTENT_TYPE,
    operationPath,
    parseEventStream,
    type StreamEvent,
    type Transport,
    UnreachableError,
} from "./client.ts";

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Sends the request; a request no daemon answers fails as unreachable. */
async function send(url: URL, init: RequestInit, baseUrl: string): Promise<Response> {
    try {
        return await fetch(url, init);
    } catch (error) {
        throw new UnreachableError(baseUrl, reasonOf(error));
    }
}

/** Reads the whole response body; a connection that closes before the body is complete fails as unreachable. */
async function readText(response: Response, baseUrl: string): Promise<string> {
    try {
        return await response.text();
    } catch (error) {
        throw new UnreachableError(baseUrl, reasonOf(error));
    }
}

function parseAnswer(text: string, status: number, baseUrl: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`The answer from ${baseUrl} is not JSON (status ${status}): ${text.slice(0, 200)}`);
    }
}

/**
 * The body's text chunks, read with `getReader()` because not every browser can iterate a `ReadableStream` with
 * `for await`. A body that fails while read fails as unreachable.
 */
async function* chunksOf(reader: ReadableStreamDefaultReader<Uint8Array>, baseUrl: string): AsyncIterable<string> {
    const decoder = new TextDecoder();
    while (true) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
            read = await reader.read();
        } catch (error) {
            throw new UnreachableError(baseUrl, reasonOf(error));
        }
        if (read.done) {
            yield decoder.decode();
            return;
        }
        yield decoder.decode(read.value, { stream: true });
    }
}

/**
 * Cancels the feed body. `cancel()` rejects when the connection failed, even while no read was pending; before `end`
 * that is the unreachable failure. After `end` the feed is complete and the stream closes anyway (S-003), so a
 * connection that fails as it closes takes nothing from the reader and is not reported.
 */
async function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>, baseUrl: string, hasEnded: boolean) {
    try {
        await reader.cancel();
    } catch (error) {
        if (!hasEnded) throw new UnreachableError(baseUrl, reasonOf(error));
    }
}

/**
 * Opens the feed route and yields its events up to and including `end`, then cancels the body. It never reopens the
 * feed, as an `EventSource` would; a body that closes or fails before `end` fails as unreachable.
 */
async function* streamEvents(baseUrl: string, path: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    try {
        yield* openedEvents(baseUrl, path, signal);
    } catch (error) {
        // An aborted read is the reader's own choice to stop, not a failure of the daemon or the connection.
        if (!signal?.aborted) throw error;
    }
}

/** The feed's events as `streamEvents` yields them, before it sets aside what an abort makes of a read. */
async function* openedEvents(baseUrl: string, path: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // `no-store` keeps the browser's HTTP cache from holding one feed request behind another.
    const response = await send(new URL(path, baseUrl), { method: "GET", cache: "no-store", signal }, baseUrl);
    if (response.status !== 200) {
        throw answerError(parseAnswer(await readText(response, baseUrl), response.status, baseUrl));
    }
    if (response.body === null) throw new UnreachableError(baseUrl, "the feed answer has no body");
    const reader = response.body.getReader();
    // Set before `end` is yielded, so a reader that stops right after `end` still counts as a complete feed.
    let hasEnded = false;
    try {
        for await (const event of parseEventStream(chunksOf(reader, baseUrl))) {
            hasEnded = event.event === "end";
            yield event;
            if (hasEnded) return;
        }
        throw new UnreachableError(baseUrl, `the feed ${path} closed before its end event`);
    } finally {
        await cancelBody(reader, baseUrl, hasEnded);
    }
}

export function browserTransport(baseUrl: string): Transport {
    return {
        async call(name, input) {
            const init = { method: "POST", headers: { "content-type": JSON_CONTENT_TYPE }, body: encodeInput(input) };
            const response = await send(new URL(operationPath(name), baseUrl), init, baseUrl);
            return parseAnswer(await readText(response, baseUrl), response.status, baseUrl);
        },
        stream: (path, signal) => streamEvents(baseUrl, path, signal),
    };
}
