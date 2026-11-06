/**
 * The feed hub with a scripted client and virtual timers (ADR-007 decisions 1, 2, 6 and 7): one instance feed and one
 * conversation stream for any number of tabs, a reopen on a change of the union, and the connection state it tells.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connections, delta, flush, type Step, setup, snapshot } from "../support/fake_feed_hub.ts";

describe("createFeedHub streams", () => {
    it("holds_one_instance_feed_and_one_stream_naming_the_union_of_three_tabs", async () => {
        const { timers, instanceFeeds, conversationFeeds, tab } = setup();
        const [a, b, c] = [tab(), tab(), tab()];
        for (const t of [a, b, c]) t.send({ type: "instance" });
        a.send({ type: "follow", conversationIds: ["c-2", "c-1"] });
        b.send({ type: "follow", conversationIds: ["c-2", "c-3"] });
        c.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        assert.equal(instanceFeeds.length, 1);
        assert.equal(conversationFeeds.length, 1);
        assert.deepEqual(conversationFeeds[0]?.ids, ["c-1", "c-2", "c-3"]);
    });

    it("passes_each_conversation_event_only_to_the_tabs_that_follow_it_and_tells_the_two_snapshots_apart", async () => {
        const { timers, instanceFeeds, conversationFeeds, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "instance" });
        a.send({ type: "follow", conversationIds: ["c-1"] });
        b.send({ type: "follow", conversationIds: ["c-2"] });
        await timers.advance(100);
        instanceFeeds[0]?.send({ item: { snapshot: { jobs: [] } } });
        conversationFeeds[0]?.send(snapshot("c-1"));
        conversationFeeds[0]?.send(delta("c-2"));
        await flush();
        assert.deepEqual(
            a.messages.filter((message) => message.type !== "connection"),
            [
                { type: "instance-snapshot", snapshot: { jobs: [] } },
                { type: "conversation-snapshot", conversationId: "c-1", snapshot: { id: "c-1" } },
            ],
        );
        assert.deepEqual(
            b.messages.filter((message) => message.type !== "connection"),
            [{ type: "conversation-delta", conversationId: "c-2", delta: { for: "c-2" } }],
        );
    });

    it("sends_instance_deltas_only_to_tabs_that_asked_for_instance_events", async () => {
        const { instanceFeeds, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "instance" });
        b.send({ type: "follow", conversationIds: [] });
        await flush();
        instanceFeeds[0]?.send({ item: { delta: { n: 1 } } });
        await flush();
        assert.deepEqual(a.messages, [{ type: "instance-delta", delta: { n: 1 } }]);
        assert.deepEqual(b.messages, []);
    });
});

describe("createFeedHub reopening", () => {
    it("aborts_the_old_stream_after_100_ms_then_opens_one_new_stream_and_tells_no_tab_it_is_lost", async () => {
        const { timers, conversationFeeds, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        b.send({ type: "follow", conversationIds: ["c-2"] });
        await timers.advance(99);
        assert.equal(conversationFeeds.length, 1);
        assert.equal(conversationFeeds[0]?.signal?.aborted, false);
        await timers.advance(1);
        assert.equal(conversationFeeds[0]?.signal?.aborted, true);
        assert.equal(conversationFeeds.length, 2);
        assert.deepEqual(conversationFeeds[1]?.ids, ["c-1", "c-2"]);
        await timers.advance(5000);
        assert.equal(conversationFeeds.length, 2);
        assert.deepEqual(connections(a.messages), []);
        assert.deepEqual(connections(b.messages), []);
    });

    it("gathers_changes_made_within_the_100_ms_into_one_reopen", async () => {
        const { timers, conversationFeeds, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(60);
        b.send({ type: "follow", conversationIds: ["c-2"] });
        await timers.advance(100);
        assert.equal(conversationFeeds.length, 1);
        assert.deepEqual(conversationFeeds[0]?.ids, ["c-1", "c-2"]);
    });

    it("opens_no_new_stream_when_the_union_is_unchanged", async () => {
        const { timers, conversationFeeds, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        b.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        assert.equal(conversationFeeds.length, 1);
    });

    it("closes_the_stream_and_opens_none_when_the_last_followed_conversation_is_dropped", async () => {
        const { timers, conversationFeeds, tab } = setup();
        const a = tab();
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        a.send({ type: "follow", conversationIds: [] });
        await timers.advance(100);
        assert.equal(conversationFeeds[0]?.signal?.aborted, true);
        assert.equal(conversationFeeds.length, 1);
    });
});

describe("createFeedHub connection state", () => {
    it("subscribes_again_at_once_when_a_feed_ends_lagging_and_tells_no_tab_it_is_lost", async () => {
        const { instanceFeeds, conversationFeeds, timers, tab } = setup();
        const a = tab();
        a.send({ type: "instance" });
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        instanceFeeds[0]?.send({ end: "lagging" });
        conversationFeeds[0]?.send({ end: "lagging" });
        await flush();
        assert.equal(instanceFeeds.length, 2);
        assert.deepEqual(conversationFeeds[1]?.ids, ["c-1"]);
        assert.deepEqual(connections(a.messages), []);
    });

    for (const [name, step] of [
        ["stopped", { end: "stopped" }],
        ["unavailable", { fail: Object.assign(new Error("starting"), { code: "unavailable" }) }],
        ["unreachable", { fail: new Error("No daemon answered") }],
    ] as [string, Step][]) {
        it(`subscribes_again_after_1_second_and_tells_every_tab_it_is_lost_when_a_feed_ends_${name}`, async () => {
            const { instanceFeeds, timers, tab } = setup();
            const [a, b] = [tab(), tab()];
            a.send({ type: "instance" });
            b.send({ type: "follow", conversationIds: [] });
            await flush();
            instanceFeeds[0]?.send(step);
            await timers.advance(999);
            assert.equal(instanceFeeds.length, 1);
            assert.deepEqual(connections(a.messages), [false]);
            assert.deepEqual(connections(b.messages), [false]);
            await timers.advance(1);
            assert.equal(instanceFeeds.length, 2);
        });
    }

    it("tells_every_tab_the_connection_is_back_when_a_snapshot_arrives_after_a_loss", async () => {
        const { instanceFeeds, timers, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "instance" });
        b.send({ type: "follow", conversationIds: [] });
        await flush();
        instanceFeeds[0]?.send({ end: "stopped" });
        await timers.advance(1000);
        instanceFeeds[1]?.send({ item: { snapshot: {} } });
        await flush();
        assert.deepEqual(connections(a.messages), [false, true]);
        assert.deepEqual(connections(b.messages), [false, true]);
    });

    it("tells_a_tab_that_asks_for_instance_events_the_state_the_worker_already_knows", async () => {
        const { instanceFeeds, tab } = setup();
        const a = tab();
        a.send({ type: "instance" });
        await flush();
        instanceFeeds[0]?.send({ end: "stopped" });
        await flush();
        const late = tab();
        late.send({ type: "instance" });
        assert.deepEqual(connections(late.messages), [false]);
    });
});

describe("createFeedHub status check", () => {
    it("calls_daemon_status_every_10_seconds", async () => {
        const { timers, status, tab } = setup();
        tab().send({ type: "instance" });
        await timers.advance(9999);
        assert.equal(status.calls, 0);
        await timers.advance(1);
        assert.equal(status.calls, 1);
        await timers.advance(10_000);
        assert.equal(status.calls, 2);
    });

    for (const [name, answer] of [
        ["fails", () => Promise.reject(new Error("refused"))],
        ["reports_stopping", () => Promise.resolve({ phase: "stopping" })],
        ["takes_over_5_seconds", () => new Promise<unknown>(() => {})],
    ] as [string, () => Promise<unknown>][]) {
        it(`treats_the_connection_as_lost_when_daemon_status_${name}`, async () => {
            const { timers, status, tab } = setup();
            const a = tab();
            a.send({ type: "instance" });
            status.answer = answer;
            await timers.advance(10_000);
            if (name === "takes_over_5_seconds") {
                assert.deepEqual(connections(a.messages), []);
                await timers.advance(4999);
                assert.deepEqual(connections(a.messages), []);
                await timers.advance(1);
            }
            assert.deepEqual(connections(a.messages), [false]);
        });
    }

    it("checks_at_once_when_a_tab_reports_a_failed_call", async () => {
        const { timers, status, tab } = setup();
        const a = tab();
        a.send({ type: "instance" });
        status.answer = () => Promise.reject(new Error("refused"));
        a.send({ type: "call-failed" });
        await timers.advance(0);
        assert.equal(status.calls, 1);
        assert.deepEqual(connections(a.messages), [false]);
    });
});

describe("createFeedHub leaving tabs", () => {
    it("drops_a_leaving_tabs_conversations_from_the_union_at_the_next_change_and_sends_it_nothing", async () => {
        const { timers, conversationFeeds, tab } = setup();
        const [a, b] = [tab(), tab()];
        a.send({ type: "follow", conversationIds: ["c-1"] });
        b.send({ type: "follow", conversationIds: ["c-2"] });
        await timers.advance(100);
        a.send({ type: "leaving" });
        await timers.advance(1000);
        assert.equal(conversationFeeds.length, 1);
        conversationFeeds[0]?.send(delta("c-1"));
        await flush();
        assert.deepEqual(a.messages, []);
        b.send({ type: "follow", conversationIds: ["c-2", "c-3"] });
        await timers.advance(100);
        assert.deepEqual(conversationFeeds[1]?.ids, ["c-2", "c-3"]);
    });

    it("opens_no_new_stream_when_a_returning_tab_follows_again_before_any_change", async () => {
        const { timers, conversationFeeds, tab } = setup();
        const a = tab();
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        a.send({ type: "leaving" });
        a.send({ type: "follow", conversationIds: ["c-1"] });
        await timers.advance(100);
        assert.equal(conversationFeeds.length, 1);
        conversationFeeds[0]?.send(delta("c-1"));
        await flush();
        assert.equal(a.messages.length, 1);
    });
});
