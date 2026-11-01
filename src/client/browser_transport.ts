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
 * `for await`. A body that fails while read fails as unreachable; a reader that stops early cancels the body.
 */
async function* chunksOf(body: ReadableStream<Uint8Array>, baseUrl: string): AsyncIterable<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // Cancelling a body that already closed or failed is not needed, and on a failed body it would throw again.
    let isSettled = false;
    try {
        while (true) {
            let read: ReadableStreamReadResult<Uint8Array>;
            try {
                read = await reader.read();
            } catch (error) {
                isSettled = true;
                throw new UnreachableError(baseUrl, reasonOf(error));
            }
            if (read.done) {
                isSettled = true;
                yield decoder.decode();
                return;
            }
            yield decoder.decode(read.value, { stream: true });
        }
    } finally {
        if (!isSettled) await reader.cancel();
    }
}

/**
 * Opens the feed route and yields its events up to and including `end`, then cancels the body. It never reopens the
 * feed, as an `EventSource` would; a body that closes before `end` fails as unreachable.
 */
async function* streamEvents(baseUrl: string, path: string): AsyncIterable<StreamEvent> {
    const response = await send(new URL(path, baseUrl), { method: "GET" }, baseUrl);
    if (response.status !== 200) {
        throw answerError(parseAnswer(await readText(response, baseUrl), response.status, baseUrl));
    }
    if (response.body === null) throw new UnreachableError(baseUrl, "the feed answer has no body");
    for await (const event of parseEventStream(chunksOf(response.body, baseUrl))) {
        yield event;
        if (event.event === "end") return;
    }
    throw new UnreachableError(baseUrl, `the feed ${path} closed before its end event`);
}

export function browserTransport(baseUrl: string): Transport {
    return {
        async call(name, input) {
            const init = { method: "POST", headers: { "content-type": JSON_CONTENT_TYPE }, body: encodeInput(input) };
            const response = await send(new URL(operationPath(name), baseUrl), init, baseUrl);
            return parseAnswer(await readText(response, baseUrl), response.status, baseUrl);
        },
        stream: (path) => streamEvents(baseUrl, path),
    };
}
