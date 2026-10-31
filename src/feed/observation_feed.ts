/**
 * The observation feed (S-002 component 8): a snapshot, then deltas, per scope. Publishing never waits for a
 * subscriber. Each subscription buffers its undelivered deltas, and a subscriber that falls too far behind is closed
 * with reason `lagging` and has to subscribe again from a fresh snapshot (R-14, R-15).
 */

import type { HarnessHost } from "../host/harness_host.ts";
import { type ConversationView, watchConversation } from "../host/host_observation.ts";

export const FEED_MAX_PENDING = 1000;

export type CloseReason = "lagging" | "unsubscribed" | "stopped";
export type NextResult<D> = { delta: D } | { closed: CloseReason };
export type Subscription<S, D> = {
    snapshot: S;
    next(): Promise<NextResult<D>>;
    close(): void;
};
export type ConversationDelta = { seq: number; view: ConversationView; ops: unknown[] };
export type ObservationFeed = {
    subscribeConversation(id: string): Promise<Subscription<ConversationView, ConversationDelta>>;
    close(): void;
};

/**
 * Creates a pull-based subscription. `push` only queues: it never awaits the subscriber. `onClosed` runs once, when
 * the subscription closes for any reason, so the producer can stop feeding it.
 */
export function createSubscription<S, D>(
    snapshot: S,
    maxPending: number = FEED_MAX_PENDING,
    onClosed?: (reason: CloseReason) => void,
): { subscription: Subscription<S, D>; push(delta: D): void; end(reason: CloseReason): void } {
    const pending: D[] = [];
    let closedReason: CloseReason | undefined;
    let waiting: ((result: NextResult<D>) => void) | undefined;

    function end(reason: CloseReason): void {
        if (closedReason) return;
        closedReason = reason;
        pending.length = 0;
        waiting?.({ closed: reason });
        waiting = undefined;
        onClosed?.(reason);
    }

    function push(delta: D): void {
        if (closedReason) return;
        if (waiting) {
            waiting({ delta });
            waiting = undefined;
            return;
        }
        pending.push(delta);
        if (pending.length > maxPending) end("lagging");
    }

    const subscription: Subscription<S, D> = {
        snapshot,
        next() {
            if (pending.length > 0) return Promise.resolve({ delta: pending.shift() as D });
            if (closedReason) return Promise.resolve({ closed: closedReason });
            return new Promise((resolve) => {
                waiting = resolve;
            });
        },
        close: () => end("unsubscribed"),
    };
    return { subscription, push, end };
}

export function createObservationFeed(options: { host: HarnessHost; maxPending?: number }): ObservationFeed {
    const { host, maxPending } = options;
    const active = new Set<{ end(reason: CloseReason): void }>();

    return {
        async subscribeConversation(id) {
            // Frames can arrive before the watch is returned; they are held until the subscription exists.
            let sink: ((frame: { view: ConversationView; ops: unknown[] }) => void) | undefined;
            const early: { view: ConversationView; ops: unknown[] }[] = [];
            const watch = await watchConversation(host, id, (frame) => (sink ? sink(frame) : early.push(frame)));

            let seq = 0;
            const entry = { end: (_reason: CloseReason) => {} };
            const { subscription, push, end } = createSubscription<ConversationView, ConversationDelta>(
                watch.snapshot,
                maxPending,
                () => {
                    active.delete(entry);
                    void watch.stop();
                },
            );
            entry.end = end;
            active.add(entry);
            sink = (frame) => push({ seq: ++seq, view: frame.view, ops: frame.ops });
            for (const frame of early.splice(0)) sink(frame);
            return subscription;
        },
        close() {
            for (const entry of [...active]) entry.end("stopped");
        },
    };
}
