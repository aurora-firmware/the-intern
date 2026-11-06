/**
 * The logic of the shared worker (ADR-007): the tabs of one browser share one instance feed and one conversation
 * stream, and the hub tells each tab the events it asked for and whether the connection holds. It touches no browser
 * API: the client, the timers and the tab ports are passed in. A worker gets no import map, so it imports by relative
 * path, and only types from the client.
 */
import type { Client, ConversationFeedItem, FeedItem } from "./client/client.ts";

/** What a tab tells the hub. A returning tab (`pageshow`) sends `follow` again. */
export type TabMessage =
    | { type: "instance" }
    | { type: "follow"; conversationIds: readonly string[] }
    | { type: "leaving" }
    | { type: "call-failed" };

/** What the hub tells a tab. An instance snapshot and a conversation's snapshot are different messages. */
export type WorkerMessage =
    | { type: "instance-snapshot"; snapshot: unknown }
    | { type: "instance-delta"; delta: unknown }
    | { type: "conversation-snapshot"; conversationId: string; snapshot: unknown }
    | { type: "conversation-delta"; conversationId: string; delta: unknown }
    | { type: "connection"; isConnected: boolean };

export type TabPort = { postMessage(message: WorkerMessage): void };

/** Calls `callback` after `delayMs`; the returned function cancels it. */
export type SetTimer = (callback: () => void, delayMs: number) => () => void;

export type FeedHub = { receive(port: TabPort, message: TabMessage): void };

const GATHER_MS = 100;
const RETRY_MS = 1000;
const STATUS_INTERVAL_MS = 10_000;
const STATUS_BOUND_MS = 5000;
const LAGGING_REASON = "lagging";
const TIMED_OUT = Symbol("timed out");

type Tab = { wantsInstance: boolean; conversationIds: ReadonlySet<string> };
type Item = FeedItem | ConversationFeedItem;
type Feed = AsyncGenerator<Item, { end: string }>;

type FeedLoop = {
    /** Aborts the open subscription, then opens a new one after `delayMs`. */
    restart(delayMs: number): void;
    stop(): void;
};

type FeedLoopOptions = {
    setTimer: SetTimer;
    open: (signal: AbortSignal) => Feed;
    onItem: (item: Item) => void;
    onLost: () => void;
};

/** The next step of the feed, or `undefined` when the subscription failed. */
async function nextStep(feed: Feed): Promise<IteratorResult<Item, { end: string }> | undefined> {
    try {
        return await feed.next();
    } catch {
        return undefined;
    }
}

/**
 * Keeps one subscription open. A subscription that ends because this loop aborted it is a reopen. Any other end is
 * subscribed again: at once after `lagging`, otherwise after the retry delay, and the tabs are told it was lost.
 */
function createFeedLoop({ setTimer, open, onItem, onLost }: FeedLoopOptions): FeedLoop {
    let controller: AbortController | undefined;
    let cancelTimer: (() => void) | undefined;

    const stop = () => {
        controller?.abort();
        controller = undefined;
        cancelTimer?.();
        cancelTimer = undefined;
    };
    const restart = (delayMs: number) => {
        stop();
        if (delayMs === 0) begin();
        else cancelTimer = setTimer(begin, delayMs);
    };
    const run = async (signal: AbortSignal) => {
        const feed = open(signal);
        let step = await nextStep(feed);
        while (step !== undefined && !step.done) {
            if (signal.aborted) return;
            onItem(step.value);
            step = await nextStep(feed);
        }
        if (signal.aborted) return;
        if (step?.value.end === LAGGING_REASON) return restart(0);
        onLost();
        restart(RETRY_MS);
    };
    function begin() {
        cancelTimer = undefined;
        controller = new AbortController();
        void run(controller.signal);
    }
    return { restart, stop };
}

function isSameSet(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
    return first.size === second.size && [...first].every((id) => second.has(id));
}

export function createFeedHub({ client, setTimer }: { client: Client; setTimer: SetTimer }): FeedHub {
    const tabs = new Map<TabPort, Tab>();
    let isConnected: boolean | undefined;
    let openedIds: ReadonlySet<string> = new Set();
    let isGathering = false;
    let pendingCheck: Promise<void> | undefined;
    let hasStarted = false;

    const tellAll = (message: WorkerMessage) => {
        for (const port of tabs.keys()) port.postMessage(message);
    };
    const setConnected = (value: boolean) => {
        if (isConnected === value) return;
        isConnected = value;
        tellAll({ type: "connection", isConnected: value });
    };

    const instanceLoop = createFeedLoop({
        setTimer,
        open: (signal) => client.subscribe({ scope: "instance" }, { signal }) as Feed,
        onItem: (item) => {
            if ("snapshot" in item) setConnected(true);
            const message: WorkerMessage =
                "snapshot" in item
                    ? { type: "instance-snapshot", snapshot: item.snapshot }
                    : { type: "instance-delta", delta: (item as { delta: unknown }).delta };
            for (const [port, tab] of tabs) if (tab.wantsInstance) port.postMessage(message);
        },
        onLost: () => setConnected(false),
    });

    const conversationLoop = createFeedLoop({
        setTimer,
        open: (signal) => client.subscribeConversations([...openedIds], { signal }) as Feed,
        onItem: (item) => {
            if (!("conversationId" in item)) return;
            if ("snapshot" in item) setConnected(true);
            const message: WorkerMessage =
                "snapshot" in item
                    ? { type: "conversation-snapshot", conversationId: item.conversationId, snapshot: item.snapshot }
                    : { type: "conversation-delta", conversationId: item.conversationId, delta: item.delta };
            for (const [port, tab] of tabs) if (tab.conversationIds.has(item.conversationId)) port.postMessage(message);
        },
        onLost: () => setConnected(false),
    });

    const unionOfTabs = (): ReadonlySet<string> => {
        const union = new Set<string>();
        for (const tab of tabs.values()) for (const id of tab.conversationIds) union.add(id);
        return new Set([...union].sort());
    };

    const reopen = () => {
        isGathering = false;
        const union = unionOfTabs();
        if (isSameSet(union, openedIds)) return;
        openedIds = union;
        if (union.size === 0) conversationLoop.stop();
        else conversationLoop.restart(0);
    };
    const scheduleReopen = () => {
        if (isGathering) return;
        isGathering = true;
        setTimer(reopen, GATHER_MS);
    };

    const statusIsHealthy = async (): Promise<boolean> => {
        let cancelBound = () => {};
        const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
            cancelBound = setTimer(() => resolve(TIMED_OUT), STATUS_BOUND_MS);
        });
        try {
            const status = await Promise.race([client.invoke("daemon.status"), timedOut]);
            return status !== TIMED_OUT && (status as { phase?: string }).phase !== "stopping";
        } catch {
            return false;
        } finally {
            cancelBound();
        }
    };
    const checkStatus = (): Promise<void> => {
        pendingCheck ??= statusIsHealthy()
            .then((isHealthy) => {
                if (isHealthy) return;
                setConnected(false);
                instanceLoop.restart(RETRY_MS);
                if (openedIds.size > 0) conversationLoop.restart(RETRY_MS);
            })
            .finally(() => {
                pendingCheck = undefined;
            });
        return pendingCheck;
    };
    const pollStatus = () => {
        setTimer(() => {
            void checkStatus().finally(pollStatus);
        }, STATUS_INTERVAL_MS);
    };

    const tabOf = (port: TabPort): Tab => {
        let tab = tabs.get(port);
        if (tab === undefined) {
            tab = { wantsInstance: false, conversationIds: new Set() };
            tabs.set(port, tab);
        }
        return tab;
    };

    return {
        receive(port, message) {
            if (!hasStarted) {
                hasStarted = true;
                pollStatus();
            }
            const tab = tabOf(port);
            switch (message.type) {
                case "instance":
                    if (!tab.wantsInstance) {
                        tab.wantsInstance = true;
                        if (isConnected !== undefined) port.postMessage({ type: "connection", isConnected });
                        if (![...tabs.values()].some((other) => other !== tab && other.wantsInstance)) {
                            instanceLoop.restart(0);
                        }
                    }
                    return;
                case "follow": {
                    const next = new Set(message.conversationIds);
                    if (isSameSet(next, tab.conversationIds)) return;
                    tab.conversationIds = next;
                    scheduleReopen();
                    return;
                }
                case "leaving":
                    tab.conversationIds = new Set();
                    return;
                case "call-failed":
                    void checkStatus();
                    return;
            }
        },
    };
}
