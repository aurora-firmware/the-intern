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
