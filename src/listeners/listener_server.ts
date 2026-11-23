/**
 * The HTTP server under a listener: it listens on a socket path or a host and port and hands every request to the
 * front with a signal that aborts at stop. Its timeouts outlast the longest call (S-003 REQ-012), and stopping it ends
 * every call and stream within the daemon's stop bound (S-003 REQ-010).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpFront } from "./http_front.ts";

export type ListenTarget = { path: string } | { host: string; port: number };

export type ListenerServer = { server: Server; address: ListenTarget; stop(): Promise<void> };

/** Above `submissions.wait`'s 5-minute maximum, so the server never cuts a call short (S-003 REQ-012). */
export const LISTENER_TIMEOUT_MS = 330_000;

/** How long `stop()` lets the answers to aborted calls flush before it closes the remaining connections. */
const FLUSH_GRACE_MS = 1_000;

function describeTarget(target: ListenTarget): string {
    return "path" in target ? target.path : `${target.host}:${target.port}`;
}

/** Answers a request the front failed on, so its rejection never goes unhandled and the client is not left waiting. */
function answerFrontFailure(res: ServerResponse): void {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const text = JSON.stringify({ error: { code: "internal", message: "The listener could not answer the request" } });
    res.shouldKeepAlive = false;
    res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
    });
    res.end(text);
}

function listen(server: Server, target: ListenTarget): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            reject(new Error(`Could not listen on ${describeTarget(target)}: ${error.message}`, { cause: error }));
        };
        server.once("error", onError);
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        if ("path" in target) server.listen(target.path, onListening);
        else server.listen(target.port, target.host, onListening);
    });
}

function addressOf(server: Server, target: ListenTarget): ListenTarget {
    if ("path" in target) return target;
    const { address, port } = server.address() as AddressInfo;
    return { host: address, port };
}

/**
 * Stops accepting connections and aborts the signal, so the front answers running calls and ends its streams. The
 * connections still open after the grace are closed, whatever they are doing.
 */
async function stopServer(server: Server, abort: AbortController): Promise<void> {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    abort.abort();
    const graceTimer = setTimeout(() => server.closeAllConnections(), FLUSH_GRACE_MS);
    try {
        await closed;
    } finally {
        clearTimeout(graceTimer);
    }
}

export async function startListenerServer(front: HttpFront, target: ListenTarget): Promise<ListenerServer> {
    const abort = new AbortController();
    const server = createServer({ requestTimeout: LISTENER_TIMEOUT_MS }, (req, res) => {
        // An answer finished after stop() leaves its connection idle; close it rather than wait for the grace.
        res.once("finish", () => {
            if (abort.signal.aborted) server.closeIdleConnections();
        });
        front.handle(req, res, { signal: abort.signal }).catch(() => answerFrontFailure(res));
    });
    server.setTimeout(LISTENER_TIMEOUT_MS);
    await listen(server, target);
    let stopping: Promise<void> | undefined;
    return {
        server,
        address: addressOf(server, target),
        stop() {
            stopping ??= stopServer(server, abort);
            return stopping;
        },
    };
}
