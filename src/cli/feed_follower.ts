/**
 * How a following command keeps a feed across daemon restarts and lag (S-005 REQ-015). `followFeed` subscribes, hands
 * each snapshot and delta to the command, and subscribes again when the feed ends `lagging` or the daemon can't be
 * reached or is starting or stopping. `createEntryTracker` lets the command print a conversation's missed entries once,
 * paging `conversations.entries` forward from the cursor it kept. Imports the client library only, never the daemon.
 */
import { type Client, ClientError, type FeedItem, type FeedScope, UnreachableError } from "../client/client.ts";

const DEFAULT_RETRY_DELAY_MS = 1000;
const LAGGING_REASON = "lagging";
const ENTRIES_PAGE_LIMIT = 500;

export const UNREACHABLE_NOTICE = "The Intern isn't reachable; trying again";
export const UNAVAILABLE_NOTICE = "The Intern is starting or stopping; trying again";

export type FollowOptions = {
    /** Creates the client of one attempt; called anew for each subscription. */
    connect(): Client;
    scope: FeedScope;
    onSnapshot(snapshot: unknown, client: Client): Promise<void>;
    onDelta(delta: unknown): Promise<void>;
    onNotice(text: string): void;
    signal: AbortSignal;
    retryDelayMs?: number;
};

/** Why an attempt could not go on: the daemon isn't there, or answers `unavailable`. Any other failure is thrown. */
function noticeFor(error: unknown): string | undefined {
    if (error instanceof UnreachableError) return UNREACHABLE_NOTICE;
    if (error instanceof ClientError && error.code === "unavailable") return UNAVAILABLE_NOTICE;
    return undefined;
}

/** Resolves after the delay, or at once when the signal aborts. */
function pause(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal.addEventListener("abort", finish, { once: true });
    });
}

/** Resolves with `aborted` when the signal aborts, so a wait on the feed can be given up. */
function whenAborted(signal: AbortSignal): { promise: Promise<"aborted">; release(): void } {
    let release = () => {};
    const promise = new Promise<"aborted">((resolve) => {
        const onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
        release = () => signal.removeEventListener("abort", onAbort);
    });
    return { promise, release };
}

type SubscriptionEnd = { hasSnapshot: boolean; reason?: string };

/** Reads one subscription to its end. Returns whether a snapshot arrived and the end reason; none when aborted. */
async function readSubscription(options: FollowOptions, client: Client): Promise<SubscriptionEnd> {
    const { scope, onSnapshot, onDelta, signal } = options;
    const subscription = client.subscribe(scope);
    const aborted = whenAborted(signal);
    let hasSnapshot = false;
    try {
        while (!signal.aborted) {
            const step = await Promise.race([subscription.next(), aborted.promise]);
            if (step === "aborted") return { hasSnapshot };
            if (step.done) return { hasSnapshot, reason: step.value.end };
            const item: FeedItem = step.value;
            if ("snapshot" in item) {
                hasSnapshot = true;
                await onSnapshot(item.snapshot, client);
            } else {
                await onDelta(item.delta);
            }
        }
        return { hasSnapshot };
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { hasSnapshot });
    } finally {
        aborted.release();
        // Not awaited: a generator waiting for the daemon finishes its return only when its next event arrives.
        subscription.return({ end: "unsubscribed" }).catch(() => {});
    }
}

/**
 * Follows the feed of the scope until the signal aborts. A feed that ends, whatever the reason, is subscribed again;
 * after `lagging` at once, otherwise after the retry delay. One notice is written per outage, not per attempt.
 */
export async function followFeed(options: FollowOptions): Promise<void> {
    const { connect, onNotice, signal, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options;
    let isOutageNoticed = false;
    while (!signal.aborted) {
        try {
            const { hasSnapshot, reason } = await readSubscription(options, connect());
            if (hasSnapshot) isOutageNoticed = false;
            if (signal.aborted) return;
            if (reason !== LAGGING_REASON) await pause(retryDelayMs, signal);
        } catch (error) {
            const notice = noticeFor(error);
            if (notice === undefined) throw error;
            if ((error as { hasSnapshot?: boolean }).hasSnapshot) isOutageNoticed = false;
            if (!isOutageNoticed) onNotice(notice);
            isOutageNoticed = true;
            await pause(retryDelayMs, signal);
        }
    }
}

export type AttributedEntryLike = { id: string; [field: string]: unknown };

export type EntryTracker = {
    /** Reads the entries after the kept cursor and returns those not printed yet, marking them printed. */
    catchUp(client: Client): Promise<AttributedEntryLike[]>;
    markPrinted(entryId: string): void;
};

type EntriesPage = { entries: AttributedEntryLike[]; next?: string };

/** Remembers which entries of one conversation were printed and where the next catch-up reads from. */
export function createEntryTracker(conversationId: string): EntryTracker {
    const printedIds = new Set<string>();
    let cursor: string | undefined;

    async function readPage(client: Client, after: string | undefined): Promise<EntriesPage> {
        const input = { conversationId, limit: ENTRIES_PAGE_LIMIT, ...(after !== undefined && { after }) };
        return (await client.invoke("conversations.entries", input)) as EntriesPage;
    }

    return {
        async catchUp(client) {
            const missed: AttributedEntryLike[] = [];
            let after = cursor;
            while (true) {
                const page = await readPage(client, after);
                for (const entry of page.entries) {
                    if (!printedIds.has(entry.id)) missed.push(entry);
                }
                // The last page has no `next`; the cursor stays on it so the next catch-up starts there.
                if (page.next === undefined) break;
                after = page.next;
            }
            // Marked only once every page is read, so a read that fails midway loses no entry.
            cursor = after;
            for (const entry of missed) printedIds.add(entry.id);
            return missed;
        },
        markPrinted(entryId) {
            printedIds.add(entryId);
        },
    };
}
