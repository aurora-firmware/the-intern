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

export async function streamFeed(
    subscription: Subscription<unknown, { seq: number }>,
    res: ServerResponse,
    _signal: AbortSignal,
): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    res.write(formatEvent({ name: "snapshot", data: subscription.snapshot }));
    for (;;) {
        const result = await subscription.next();
        if ("closed" in result) {
            res.end(formatEvent({ name: "end", data: { reason: result.closed } }));
            return;
        }
        res.write(formatEvent({ name: "delta", id: result.delta.seq, data: result.delta }));
    }
}
