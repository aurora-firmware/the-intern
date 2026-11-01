/**
 * Writes an observation feed subscription to an HTTP response as Server-Sent Events (S-003 REQ-006): a `snapshot`
 * event, then one `delta` event per delta with its sequence number as the event id, and an `end` event with the reason
 * the subscription closed.
 */
import type { ServerResponse } from "node:http";
import type { Subscription } from "../feed/observation_feed.ts";

type FeedEvent = { name: "snapshot" | "delta" | "end"; id?: number; data: unknown };

function formatEvent(event: FeedEvent): string {
    const idLine = event.id === undefined ? "" : `id: ${event.id}\n`;
    // JSON.stringify escapes line breaks, so the data always fits on one `data` line.
    return `event: ${event.name}\n${idLine}data: ${JSON.stringify(event.data)}\n\n`;
}

/** Resolves once the response can take more: at once, or when it drains or closes. */
function writeEvent(res: ServerResponse, event: FeedEvent): Promise<void> {
    if (res.write(formatEvent(event))) return Promise.resolve();
    return new Promise((resolve) => {
        const settle = () => {
            res.off("drain", settle);
            res.off("close", settle);
            resolve();
        };
        res.on("drain", settle);
        res.on("close", settle);
    });
}

/**
 * The next delta is pulled only once the previous one is written and the response has drained, so a client that
 * doesn't read leaves the deltas in the subscription, whose bound closes it `lagging` (S-003 REQ-011).
 */
export async function streamFeed(
    subscription: Subscription<unknown, { seq: number }>,
    res: ServerResponse,
    _signal: AbortSignal,
): Promise<void> {
    // A client that leaves is unsubscribed; on a response that ended first, closing again does nothing.
    res.on("close", () => subscription.close());
    if (res.closed) subscription.close();
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    await writeEvent(res, { name: "snapshot", data: subscription.snapshot });
    for (;;) {
        const result = await subscription.next();
        if ("closed" in result) {
            // Only the client leaving unsubscribes, and no event can reach it then.
            if (result.closed === "unsubscribed") return;
            res.end(formatEvent({ name: "end", data: { reason: result.closed } }));
            return;
        }
        await writeEvent(res, { name: "delta", id: result.delta.seq, data: result.delta });
    }
}
