/**
 * Writes an observation feed subscription to an HTTP response as Server-Sent Events (S-003 REQ-006): a `snapshot`
 * event, then one `delta` event per delta with its sequence number as the event id, and an `end` event with the reason
 * the stream ends.
 */
import type { ServerResponse } from "node:http";
import type { CloseReason, Subscription } from "../feed/observation_feed.ts";

type FeedEvent = { name: "snapshot" | "delta" | "end"; id?: number; data: unknown };

/** How long an ended stream may take to flush its last events before its connection is closed. */
const FINAL_FLUSH_MS = 1000;

function formatEvent(event: FeedEvent): string {
    const idLine = event.id === undefined ? "" : `id: ${event.id}\n`;
    // JSON.stringify escapes line breaks, so the data always fits on one `data` line.
    return `event: ${event.name}\n${idLine}data: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Resolves once the response can take more: at once, or when it drains, closes or `wake` aborts. A client that stops
 * reading never drains, so `wake` also aborts when the subscription closes `lagging` (S-003 REQ-011), as well as at
 * shutdown. Every listener is removed when the wait settles, so a long stream gathers none. A destroyed response
 * refuses the write and has already closed, so it resolves at once too.
 */
function writeEvent(res: ServerResponse, event: FeedEvent, wake: AbortSignal): Promise<void> {
    if (res.write(formatEvent(event)) || res.destroyed || wake.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const settle = () => {
            res.off("drain", settle);
            res.off("close", settle);
            wake.removeEventListener("abort", settle);
            resolve();
        };
        res.on("drain", settle);
        res.on("close", settle);
        wake.addEventListener("abort", settle, { once: true });
    });
}

/**
 * Ends the response with the reason the stream ends, unless the client has already left. A client that doesn't read
 * can't take the last event, so its connection is closed once the event has had `FINAL_FLUSH_MS` to flush.
 */
function finish(res: ServerResponse, closedReason: CloseReason, signal: AbortSignal): void {
    if (res.destroyed) return;
    // The stream closes its own subscription at shutdown, which ends it `unsubscribed`; the client hears `stopped`.
    const reason = signal.aborted ? "stopped" : closedReason;
    if (reason === "unsubscribed") res.end();
    else res.end(formatEvent({ name: "end", data: { reason } }));
    if (res.writableFinished) return;
    const timer = setTimeout(() => res.destroy(), FINAL_FLUSH_MS);
    timer.unref();
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => clearTimeout(timer));
}

/**
 * The next delta is pulled only once the previous one is written and the response has drained, so a client that
 * doesn't read leaves the deltas in the subscription, whose bound closes it `lagging` (S-003 REQ-011). The client
 * leaving or the signal aborting closes the subscription (S-003 REQ-006, REQ-010).
 */
export async function streamFeed(
    subscription: Subscription<unknown, { seq: number }>,
    res: ServerResponse,
    signal: AbortSignal,
): Promise<void> {
    const stop = () => subscription.close();
    // On a response that ended first, closing the subscription again does nothing.
    res.on("close", stop);
    signal.addEventListener("abort", stop, { once: true });
    if (res.closed || signal.aborted) stop();
    // One callback on the subscription closing for the whole stream, not one per write.
    const subscriptionClosed = new AbortController();
    void subscription.closed.then(() => subscriptionClosed.abort());
    const wake = AbortSignal.any([signal, subscriptionClosed.signal]);
    try {
        // A quiet stream is still being read, so the server's idle timeout must not end it (S-003 REQ-012).
        res.setTimeout(0);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        await writeEvent(res, { name: "snapshot", data: subscription.snapshot }, wake);
        for (;;) {
            const result = await subscription.next();
            if ("closed" in result) return finish(res, result.closed, signal);
            await writeEvent(res, { name: "delta", id: result.delta.seq, data: result.delta }, wake);
        }
    } finally {
        signal.removeEventListener("abort", stop);
    }
}
