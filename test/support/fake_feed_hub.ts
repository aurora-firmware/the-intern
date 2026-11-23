/** Fakes for the feed hub tests: a scripted client, virtual timers and recording tab ports. */
import type { Client, ConversationFeedItem, FeedItem } from "../../src/client/client.ts";
import { createFeedHub, type TabMessage, type TabPort, type WorkerMessage } from "../../web/ui/feed_hub.ts";

export type Step = { item: FeedItem | ConversationFeedItem } | { end: string } | { fail: Error };
export type Feed = { ids?: readonly string[]; signal?: AbortSignal; send(step: Step): void };

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A virtual clock: a timer fires when `advance` reaches it, and the work it starts settles before the next one. */
function fakeTimers() {
    let now = 0;
    let pending: { at: number; run: () => void }[] = [];
    return {
        setTimer(run: () => void, delayMs: number) {
            const timer = { at: now + delayMs, run };
            pending.push(timer);
            return () => {
                pending = pending.filter((entry) => entry !== timer);
            };
        },
        async advance(ms: number) {
            await flush();
            const target = now + ms;
            for (;;) {
                const due = pending.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0];
                if (due === undefined) break;
                pending = pending.filter((entry) => entry !== due);
                now = due.at;
                due.run();
                await flush();
            }
            now = target;
            await flush();
        },
    };
}

/** A feed the test drives: `send` queues what the subscription yields, returns or throws; an abort ends it. */
function openFeed(opened: Feed[], ids: readonly string[] | undefined, signal: AbortSignal | undefined) {
    const queue: Step[] = [];
    let wake = () => {};
    const feed: Feed = {
        ids,
        signal,
        send(step) {
            queue.push(step);
            wake();
        },
    };
    opened.push(feed);
    return (async function* () {
        for (;;) {
            if (signal?.aborted) return { end: "aborted" };
            const step = queue.shift();
            if (step === undefined) {
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    signal?.addEventListener("abort", () => resolve(), { once: true });
                });
                continue;
            }
            if ("item" in step) yield step.item;
            else if ("fail" in step) throw step.fail;
            else return step;
        }
    })();
}

export function setup() {
    const timers = fakeTimers();
    const instanceFeeds: Feed[] = [];
    const conversationFeeds: Feed[] = [];
    const status = { calls: 0, answer: (): Promise<unknown> => Promise.resolve({ phase: "ready" }) };
    const client = {
        invoke: () => {
            status.calls++;
            return status.answer();
        },
        subscribe: (_scope, options) => openFeed(instanceFeeds, undefined, options?.signal),
        subscribeConversations: (ids, options) => openFeed(conversationFeeds, ids, options?.signal),
    } as Client;
    const hub = createFeedHub({ client, setTimer: timers.setTimer });
    const tab = () => {
        const messages: WorkerMessage[] = [];
        const port: TabPort = { postMessage: (message) => messages.push(message) };
        return { messages, send: (message: TabMessage) => hub.receive(port, message) };
    };
    return { timers, instanceFeeds, conversationFeeds, status, tab };
}

export const snapshot = (conversationId: string): Step => ({
    item: { conversationId, snapshot: { id: conversationId } },
});
export const delta = (conversationId: string): Step => ({ item: { conversationId, delta: { for: conversationId } } });
export const connections = (messages: WorkerMessage[]) =>
    messages.flatMap((message) => (message.type === "connection" ? [message.isConnected] : []));
