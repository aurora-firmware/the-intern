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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The error a refused answer carries, `{"error": {"code", "message"}}`, as a `ClientError`. */
export function answerError(body: unknown): Error {
    const error = isRecord(body) ? body.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
        return new ClientError(error.code, error.message);
    }
    return new Error(`The daemon's answer is neither a result nor an error: ${JSON.stringify(body)?.slice(0, 200)}`);
}

/** The result of an answer `{"result": <result>}`; any other answer is thrown as its error. */
export function decodeAnswer(body: unknown): unknown {
    if (isRecord(body) && Object.hasOwn(body, "result")) return body.result;
    throw answerError(body);
}

export function createClient(transport: Transport): Client {
    return {
        invoke: async (name, input) => decodeAnswer(await transport.call(name, input)),
        subscribe: () => {
            throw new Error("Feed subscriptions are not available yet");
        },
    };
}
