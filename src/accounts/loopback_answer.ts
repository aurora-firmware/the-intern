/**
 * The listener that takes the browser's answer to Google's authorization (S-009 REQ-004). It listens on 127.0.0.1 on a
 * port the system picks, accepts one `GET` whose `state` matches, and closes. It is not an S-003 listener and carries
 * no operation.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AccountClock } from "./account_status.ts";

const LOOPBACK = "127.0.0.1";
/** How long the listener waits for the answer, on the layer's clock. */
export const LOOPBACK_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

export type LoopbackAnswerOptions = {
    /** The only `state` value a request may carry. */
    state: string;
    clock: AccountClock;
    /** Ends the listener at once when it aborts. */
    signal: AbortSignal;
    /** Exchanges the code and stores the tokens. A rejection ends the sign-in and answers the browser with an error. */
    exchange(code: string, redirectUri: string): Promise<void>;
};

export type LoopbackOutcome = { kind: "answered" } | { kind: "failed"; error: unknown } | { kind: "ended" };

export type LoopbackListener = {
    port: number;
    /** Settles when the listener has closed: after the answer, the timeout or the abort. */
    outcome: Promise<LoopbackOutcome>;
};

function page(response: http.ServerResponse, status: number, text: string): void {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    response.end(text);
}

export async function listenForLoopbackAnswer(options: LoopbackAnswerOptions): Promise<LoopbackListener> {
    const { state, clock, signal, exchange } = options;
    const timer = new AbortController();
    let resolveOutcome: (outcome: LoopbackOutcome) => void = () => {};
    const outcome = new Promise<LoopbackOutcome>((resolve) => {
        resolveOutcome = resolve;
    });
    let isAnswering = false;
    let isFinished = false;
    let redirectUri = "";

    const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? "/", `http://${LOOPBACK}`);
        const code = url.searchParams.get("code");
        if (isAnswering || request.method !== "GET" || url.searchParams.get("state") !== state || !code) {
            page(response, 400, "This address takes only the answer to the sign-in that started it.");
            return;
        }
        isAnswering = true;
        exchange(code, redirectUri).then(
            () => {
                page(response, 200, "Signed in. You can close this page.");
                finish({ kind: "answered" });
            },
            (error: unknown) => {
                page(response, 500, "The sign-in failed. Start it again.");
                finish({ kind: "failed", error });
            },
        );
    });

    function finish(result: LoopbackOutcome): void {
        if (isFinished) return;
        isFinished = true;
        timer.abort();
        server.close();
        server.closeIdleConnections();
        resolveOutcome(result);
    }

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, resolve);
    });
    const port = (server.address() as AddressInfo).port;
    redirectUri = `http://${LOOPBACK}:${port}`;

    const until = new Date(clock.now().getTime() + LOOPBACK_ANSWER_TIMEOUT_MS);
    void clock.wait(until, timer.signal).then(() => {
        if (!timer.signal.aborted) finish({ kind: "ended" });
    });
    signal.addEventListener("abort", () => finish({ kind: "ended" }), { once: true });
    if (signal.aborted) finish({ kind: "ended" });
    return { port, outcome };
}
