/**
 * The feed follower with a scripted client (S-005 REQ-015, AC-015.2): it subscribes again after `lagging`, an
 * unreachable daemon and `unavailable`, prints missed entries once from the cursor it kept, and stops on abort.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEntryTracker, followFeed } from "../../src/cli/feed_follower.ts";
import { type Client, ClientError, type FeedItem, UnreachableError } from "../../src/client/client.ts";

type Attempt = { items?: FeedItem[]; end?: string; failure?: Error; hold?: boolean };
type EntriesCall = { after?: string; limit: number; conversationId: string };
type EntriesPage = { entries: { id: string }[]; next?: string };

const CONVERSATION_SCOPE = { scope: "conversation", conversationId: "c-1" } as const;

/** A client whose n-th subscription plays the n-th attempt; `hold` keeps the feed quiet until it is closed. */
function scriptedConnect(attempts: Attempt[], entries: (call: EntriesCall) => EntriesPage = () => ({ entries: [] })) {
    const entriesCalls: EntriesCall[] = [];
    const closedAttempts: number[] = [];
    let connections = 0;
    const connect = (): Client => {
        const attemptIndex = connections++;
        const attempt = attempts[attemptIndex];
        return {
            invoke: async (_name, input) => {
                entriesCalls.push(input as EntriesCall);
                return entries(input as EntriesCall);
            },
            subscribe: async function* () {
                if (attempt === undefined) throw new Error(`unscripted attempt ${attemptIndex}`);
                try {
                    if (attempt.failure) throw attempt.failure;
                    for (const item of attempt.items ?? []) yield item;
                    if (attempt.hold) await new Promise<never>(() => {});
                    return { end: attempt.end ?? "lagging" };
                } finally {
                    closedAttempts.push(attemptIndex);
                }
            },
        };
    };
    return { connect, entriesCalls, closedAttempts, connections: () => connections };
}

describe("followFeed", () => {
    it("subscribes_again_from_a_fresh_snapshot_when_the_feed_ends_lagging", async () => {
        const script = scriptedConnect([
            { items: [{ snapshot: "s1" }, { delta: "d1" }], end: "lagging" },
            { items: [{ snapshot: "s2" }, { delta: "d2" }], hold: true },
        ]);
        const controller = new AbortController();
        const seen: string[] = [];
        await followFeed({
            connect: script.connect,
            scope: { scope: "instance" },
            onSnapshot: async (snapshot) => void seen.push(`snapshot:${snapshot}`),
            onDelta: async (delta) => {
                seen.push(`delta:${delta}`);
                if (delta === "d2") controller.abort();
            },
            onNotice: () => assert.fail("a lagging end gives no notice"),
            signal: controller.signal,
        });
        assert.deepEqual(seen, ["snapshot:s1", "delta:d1", "snapshot:s2", "delta:d2"]);
    });

    it("prints_missed_entries_once_before_the_new_deltas_after_lagging", async () => {
        const stored = ["e1", "e2", "e3"];
        const script = scriptedConnect(
            [
                { items: [{ snapshot: "s1" }, { delta: "e1" }], end: "lagging" },
                { items: [{ snapshot: "s2" }, { delta: "e4" }], hold: true },
            ],
            () => ({ entries: stored.map((id) => ({ id })) }),
        );
        const controller = new AbortController();
        const tracker = createEntryTracker("c-1");
        const printed: string[] = [];
        await followFeed({
            connect: script.connect,
            scope: CONVERSATION_SCOPE,
            onSnapshot: async (snapshot, client) => {
                if (snapshot === "s1") return;
                for (const entry of await tracker.catchUp(client)) printed.push(entry.id);
            },
            onDelta: async (delta) => {
                printed.push(String(delta));
                tracker.markPrinted(String(delta));
                if (delta === "e4") controller.abort();
            },
            onNotice: () => {},
            signal: controller.signal,
        });
        assert.deepEqual(printed, ["e1", "e2", "e3", "e4"]);
    });

    it("writes_one_notice_and_resumes_when_the_daemon_is_unreachable_then_answers", async () => {
        const script = scriptedConnect([
            { failure: new UnreachableError("/run/bob.sock", "refused") },
            { failure: new UnreachableError("/run/bob.sock", "refused") },
            { items: [{ snapshot: "s" }], hold: true },
        ]);
        const controller = new AbortController();
        const notices: string[] = [];
        const snapshots: unknown[] = [];
        await followFeed({
            connect: script.connect,
            scope: { scope: "instance" },
            onSnapshot: async (snapshot) => {
                snapshots.push(snapshot);
                controller.abort();
            },
            onDelta: async () => {},
            onNotice: (text) => notices.push(text),
            signal: controller.signal,
            retryDelayMs: 1,
        });
        assert.equal(notices.length, 1);
        assert.deepEqual(snapshots, ["s"]);
        assert.equal(script.connections(), 3);
    });

    it("writes_a_notice_and_retries_when_the_daemon_answers_unavailable", async () => {
        const script = scriptedConnect([
            { failure: new ClientError("unavailable", "The daemon is starting") },
            { items: [{ snapshot: "s" }], hold: true },
        ]);
        const controller = new AbortController();
        const notices: string[] = [];
        await followFeed({
            connect: script.connect,
            scope: { scope: "instance" },
            onSnapshot: async () => controller.abort(),
            onDelta: async () => {},
            onNotice: (text) => notices.push(text),
            signal: controller.signal,
            retryDelayMs: 1,
        });
        assert.equal(notices.length, 1);
        assert.equal(script.connections(), 2);
    });

    it("throws_a_refusal_other_than_unavailable", async () => {
        const script = scriptedConnect([{ failure: new ClientError("not_found", "No such conversation") }]);
        await assert.rejects(
            followFeed({
                connect: script.connect,
                scope: CONVERSATION_SCOPE,
                onSnapshot: async () => {},
                onDelta: async () => {},
                onNotice: () => {},
                signal: new AbortController().signal,
                retryDelayMs: 1,
            }),
            /No such conversation/,
        );
    });

    it("closes_the_subscription_and_returns_when_the_signal_aborts_on_a_quiet_feed", async () => {
        const script = scriptedConnect([{ items: [{ snapshot: "s" }], hold: true }]);
        const controller = new AbortController();
        const following = followFeed({
            connect: script.connect,
            scope: { scope: "instance" },
            onSnapshot: async () => {
                setImmediate(() => controller.abort());
            },
            onDelta: async () => {},
            onNotice: () => {},
            signal: controller.signal,
        });
        await following;
        assert.equal(script.connections(), 1);
    });

    it("returns_during_the_retry_delay_when_the_signal_aborts", async () => {
        const script = scriptedConnect([{ failure: new UnreachableError("/run/bob.sock", "refused") }]);
        const controller = new AbortController();
        await followFeed({
            connect: script.connect,
            scope: { scope: "instance" },
            onSnapshot: async () => {},
            onDelta: async () => {},
            onNotice: () => setImmediate(() => controller.abort()),
            signal: controller.signal,
            retryDelayMs: 60_000,
        });
        assert.equal(script.connections(), 1);
    });
});

describe("createEntryTracker", () => {
    it("pages_forward_from_the_kept_cursor_and_never_rereads_earlier_pages", async () => {
        const pages: Record<string, EntriesPage> = {
            start: { entries: [{ id: "e1" }, { id: "e2" }], next: "c2" },
            c2: { entries: [{ id: "e3" }] },
            c3: { entries: [{ id: "e3" }, { id: "e4" }] },
        };
        const script = scriptedConnect([], ({ after }) => pages[after ?? "start"] as EntriesPage);
        const tracker = createEntryTracker("c-1");
        const client = script.connect();
        const first = await tracker.catchUp(client);
        assert.deepEqual(
            first.map((entry) => entry.id),
            ["e1", "e2", "e3"],
        );
        assert.deepEqual(
            script.entriesCalls.map((call) => call.after),
            [undefined, "c2"],
        );
    });

    it("keeps_the_own_cursor_of_the_last_page_when_it_has_no_next", async () => {
        const calls: (string | undefined)[] = [];
        const pages: Record<string, EntriesPage> = {
            start: { entries: [{ id: "e1" }], next: "c2" },
            c2: { entries: [{ id: "e2" }] },
        };
        const script = scriptedConnect([], ({ after }) => {
            calls.push(after);
            return pages[after ?? "start"] as EntriesPage;
        });
        const tracker = createEntryTracker("c-1");
        const client = script.connect();
        await tracker.catchUp(client);
        const second = await tracker.catchUp(client);
        assert.deepEqual(second, []);
        assert.deepEqual(calls, [undefined, "c2", "c2"]);
    });

    it("skips_entries_marked_printed_from_a_delta", async () => {
        const script = scriptedConnect([], () => ({ entries: [{ id: "e1" }, { id: "e2" }] }));
        const tracker = createEntryTracker("c-1");
        tracker.markPrinted("e1");
        const missed = await tracker.catchUp(script.connect());
        assert.deepEqual(
            missed.map((entry) => entry.id),
            ["e2"],
        );
    });
});
