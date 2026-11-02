/**
 * The observation feed (S-002 Observation feed): a snapshot, then deltas, per scope. Publishing never waits for a
 * subscriber. Each subscription buffers its undelivered deltas, and a subscriber that falls too far behind is closed
 * with reason `lagging` and has to subscribe again from a fresh snapshot (S-002 REQ-014, REQ-015).
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
    /** Settles with the reason once the subscription closes, without taking a delta. */
    closed: Promise<CloseReason>;
};
export type ConversationDelta = { seq: number; view: ConversationView; ops: unknown[] };
export type ObservationFeed = {
    subscribeConversation(id: string): Promise<Subscription<ConversationView, ConversationDelta>>;
    close(): void;
};

type SubscriptionParts<S, D> = {
    subscription: Subscription<S, D>;
    push(delta: D): void;
    end(reason: CloseReason): void;
};

/** Creates a pull-based subscription. `push` only queues: it never awaits the subscriber. */
export function createSubscription<S, D>(snapshot: S, maxPending: number = FEED_MAX_PENDING): SubscriptionParts<S, D> {
    return createReleasingSubscription(snapshot, maxPending, () => {});
}

// `onClosed` runs once, when the subscription closes for any reason, so the feed can release what feeds it.
function createReleasingSubscription<S, D>(
    snapshot: S,
    maxPending: number,
    onClosed: (reason: CloseReason) => void,
): { subscription: Subscription<S, D>; push(delta: D): void; end(reason: CloseReason): void } {
    const pending: D[] = [];
    let closedReason: CloseReason | undefined;
    let waiting: ((result: NextResult<D>) => void) | undefined;
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<CloseReason>();

    function end(reason: CloseReason): void {
        if (closedReason) return;
        closedReason = reason;
        resolveClosed(reason);
        pending.length = 0;
        waiting?.({ closed: reason });
        waiting = undefined;
        onClosed(reason);
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
        closed,
    };
    return { subscription, push, end };
}

export function createObservationFeed(options: { host: HarnessHost; maxPending?: number }): ObservationFeed {
    const { host, maxPending = FEED_MAX_PENDING } = options;
    const active = new Set<{ end(reason: CloseReason): void }>();
    let isClosed = false;
    const closedError = () => new Error("The observation feed is closed; it accepts no new subscriptions.");

    return {
        async subscribeConversation(id) {
            if (isClosed) throw closedError();
            // Frames can arrive before the watch is returned; they are held until the subscription exists.
            let sink: ((frame: { view: ConversationView; ops: unknown[] }) => void) | undefined;
            const early: { view: ConversationView; ops: unknown[] }[] = [];
            const watch = await watchConversation(host, id, (frame) => (sink ? sink(frame) : early.push(frame)));
            if (isClosed) {
                await watch.stop();
                throw closedError();
            }

            let seq = 0;
            const entry = { end: (_reason: CloseReason) => {} };
            const { subscription, push, end } = createReleasingSubscription<ConversationView, ConversationDelta>(
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
            isClosed = true;
            for (const entry of [...active]) entry.end("stopped");
        },
    };
}
