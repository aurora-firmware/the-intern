/**
 * The client library (S-003 REQ-009): what the Node and browser transports share, with no Node or DOM import. It holds
 * the request and response format of the operation route, the Server-Sent Events format of the feed, the client's
 * errors, and `createClient`, through which the `bob` commands and the web interface call the daemon.
 */

/** One Server-Sent Event as the feed route sends it: its name, its id if any, and its data text. */
export type StreamEvent = { event: string; id?: string; data: string };

export type Transport = {
    /** Calls the operation and resolves with the answer's JSON body, whatever its status. */
    call(name: string, input: unknown): Promise<unknown>;
    /** Opens the feed route at `path` and yields its events until the daemon ends the stream. */
    stream(path: string): AsyncIterable<StreamEvent>;
};

/** An operation failed: `code` and `message` are the ones the in-process call gives (S-002's codes). */
export class ClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "ClientError";
        this.code = code;
    }
}

/** No daemon answered at `target`, the socket path or URL, or the connection closed before the answer. */
export class UnreachableError extends Error {
    readonly target: string;

    constructor(target: string, reason: string) {
        super(`No daemon answered at ${target}: ${reason}`);
        this.name = "UnreachableError";
        this.target = target;
    }
}

export const JSON_CONTENT_TYPE = "application/json";

export function operationPath(name: string): string {
    return `/operations/${encodeURIComponent(name)}`;
}

/** The request body of an operation call: the input as JSON, or empty for no input. */
export function encodeInput(input: unknown): string {
    return input === undefined ? "" : JSON.stringify(input);
}

export type FeedScope = { scope: "instance" } | { scope: "conversation"; conversationId: string };

export type FeedItem = { snapshot: unknown } | { delta: unknown };

export type Client = {
    invoke(name: string, input?: unknown): Promise<unknown>;
    subscribe(scope: FeedScope): AsyncGenerator<FeedItem, { end: string }>;
};

export function feedPath(scope: FeedScope): string {
    const query =
        scope.scope === "instance"
            ? new URLSearchParams({ scope: "instance" })
            : new URLSearchParams({ scope: "conversation", id: scope.conversationId });
    return `/feed?${query}`;
}

type PendingEvent = { event?: string; id?: string; dataLines: string[] };

/** Adds one field line to the pending event. */
function addField(pending: PendingEvent, line: string): void {
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "event") pending.event = value;
    else if (name === "id") pending.id = value;
    else if (name === "data") pending.dataLines.push(value);
}

/** The event a blank line completes; an event with no data is not dispatched, as in the Server-Sent Events format. */
function completed(pending: PendingEvent): StreamEvent | undefined {
    if (pending.dataLines.length === 0) return undefined;
    const data = pending.dataLines.join("\n");
    const event = pending.event ?? "message";
    return pending.id === undefined ? { event, data } : { event, id: pending.id, data };
}

/** Parses Server-Sent Events from text chunks. */
export async function* parseEventStream(chunks: AsyncIterable<string>): AsyncIterable<StreamEvent> {
    let pending: PendingEvent = { dataLines: [] };
    for await (const chunk of chunks) {
        for (const line of chunk.split("\n")) {
            if (line !== "") {
                addField(pending, line);
                continue;
            }
            const event = completed(pending);
            pending = { dataLines: [] };
            if (event) yield event;
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The result of an answer `{"result": <result>}`. */
export function decodeAnswer(body: unknown): unknown {
    return isRecord(body) ? body.result : undefined;
}

/**
 * Yields the snapshot, then the deltas, and returns the reason of the `end` event. It opens one stream only: a stream
 * that ends or breaks is never reopened, so a reader never misses deltas without knowing (S-003 REQ-009).
 */
async function* subscribe(transport: Transport, scope: FeedScope): AsyncGenerator<FeedItem, { end: string }> {
    for await (const event of transport.stream(feedPath(scope))) {
        if (event.event === "end") return { end: (JSON.parse(event.data) as { reason: string }).reason };
        if (event.event === "snapshot") yield { snapshot: JSON.parse(event.data) };
        else if (event.event === "delta") yield { delta: JSON.parse(event.data) };
    }
    return { end: "" };
}

export function createClient(transport: Transport): Client {
    return {
        invoke: async (name, input) => decodeAnswer(await transport.call(name, input)),
        subscribe: (scope) => subscribe(transport, scope),
    };
}
