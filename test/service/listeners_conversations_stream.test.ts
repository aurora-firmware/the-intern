/**
 * One feed stream for several conversations through both listeners of a real daemon (S-003 REQ-006, REQ-010,
 * REQ-011): `GET /feed?scope=conversations` sends a snapshot per named conversation and then their deltas, each event
 * naming its conversation, ends the others when one subscription ends, and ends `unsubscribed` when the client
 * leaves.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
    disposeFixtures,
    eventuallyEqual,
    type FeedEvent,
    type FeedStream,
    type Fixture,
    LAGGING_END,
    LISTENERS,
    LOOP_INPUT,
    loopingReply,
    nextEvent,
    readToEnd,
    recordSubscriptionReads,
    startFixture,
    type View,
} from "../support/listeners_feed_fixture.ts";

const TEST_TIMEOUT_MS = 90_000;
const STOPPED_END: FeedEvent = { name: "end", data: { reason: "stopped" } };

type Wrapped = { conversationId: string; event: { seq?: number; view?: View } };

afterEach(async () => {
    mock.restoreAll();
    await disposeFixtures();
});

const wrapped = (event: FeedEvent) => event.data as Wrapped;

const idsQuery = (scope: string, ids: readonly string[]) => `?scope=${scope}${ids.map((id) => `&id=${id}`).join("")}`;

/** Reads `delta` events until every conversation has been seen busy and then idle again; returns them per conversation. */
async function readDeltasUntilAllSettled(
    stream: FeedStream,
    ids: readonly string[],
    /** Set for a feed of one conversation, whose events don't name it. */
    alone?: string,
): Promise<Map<string, FeedEvent[]>> {
    const byConversation = new Map(ids.map((id) => [id, [] as FeedEvent[]]));
    const busySeen = new Set<string>();
    const settled = new Set<string>();
    while (settled.size < ids.length) {
        const event = await nextEvent(stream);
        assert.equal(event.name, "delta", `event ${JSON.stringify(event).slice(0, 200)} is a delta`);
        const { conversationId, event: delta } = alone
            ? { conversationId: alone, event: event.data as Wrapped["event"] }
            : wrapped(event);
        byConversation.get(conversationId)?.push(event);
        if (delta.view?.busy) busySeen.add(conversationId);
        else if (busySeen.has(conversationId)) settled.add(conversationId);
    }
    return byConversation;
}

async function threeConversations(fixture: Fixture): Promise<string[]> {
    return [
        await fixture.idleConversation("alpha"),
        await fixture.idleConversation("beta"),
        await fixture.idleConversation("gamma"),
    ];
}

describe("one feed stream for several conversations through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`sends a snapshot per conversation, then each one's deltas in commit order over the ${listener}`, async () => {
            const fixture = await startFixture();
            const ids = await threeConversations(fixture);
            const merged = await fixture.openFeed(listener, idsQuery("conversations", ids));
            const singles = await Promise.all(
                ids.map((id) => fixture.openFeed(listener, idsQuery("conversation", [id]))),
            );
            const singleSnapshots = await Promise.all(singles.map(nextEvent));

            const snapshots = [await nextEvent(merged), await nextEvent(merged), await nextEvent(merged)];
            await Promise.all(ids.map((id) => fixture.submitAndSettle(id, "observed run")));
            const deltas = await readDeltasUntilAllSettled(merged, ids);

            assert.equal(merged.status, 200);
            assert.deepEqual(
                snapshots.map((event) => event.name),
                ["snapshot", "snapshot", "snapshot"],
            );
            const snapshotsById = new Map(snapshots.map((event) => [wrapped(event).conversationId, event]));
            for (const [index, id] of ids.entries()) {
                assert.deepEqual(snapshotsById.get(id)?.data, {
                    conversationId: id,
                    event: singleSnapshots[index]?.data,
                });
                const own = deltas.get(id) ?? [];
                const alone = await readDeltasUntilAllSettled(singles[index] as FeedStream, [id], id);
                const expected = (alone.get(id) ?? []).map((event) => ({
                    ...event,
                    data: { conversationId: id, event: event.data },
                }));
                assert.deepEqual(
                    own.map((event) => event.id),
                    own.map((_, position) => position + 1),
                    "commit order",
                );
                assert.deepEqual(own, expected, `the deltas of conversation ${id} are those of its own feed`);
            }
        });
    }
});

describe("refused feeds for several conversations through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("refuses no id as invalid_input and an unknown id as not_found, and sends one snapshot for a repeated id", async () => {
        const fixture = await startFixture();
        const [known, other] = await threeConversations(fixture);
        assert.ok(known && other);
        const reads = recordSubscriptionReads(fixture.catalogue);

        for (const listener of LISTENERS) {
            const noId = await fixture.openFeed(listener, "?scope=conversations");
            const unknownId = await fixture.openFeed(listener, idsQuery("conversations", [known, "999", other]));
            const repeated = await fixture.openFeed(listener, idsQuery("conversations", [known, known]));

            assert.equal(noId.status, 400, `no id over the ${listener}`);
            assert.equal((await noId.refusal()).error?.code, "invalid_input");
            assert.equal(unknownId.status, 404, `an unknown id over the ${listener}`);
            assert.equal((await unknownId.refusal()).error?.code, "not_found");
            assert.equal(repeated.status, 200);
            assert.equal((await nextEvent(repeated)).name, "snapshot");
            await fixture.submitAndSettle(known, `repeated ${listener}`);
            assert.equal((await nextEvent(repeated)).name, "delta", `one snapshot only over the ${listener}`);
            repeated.close();
        }
        // The refused requests closed the subscriptions they had opened; the repeated id opened one each.
        const closedAll = () => reads.map((read) => read.at(-1));
        await eventuallyEqual(
            closedAll,
            reads.map(() => ({ closed: "unsubscribed" })),
            "every subscription ends unsubscribed",
        );
    });
});

describe("the end of a feed stream for several conversations", { timeout: TEST_TIMEOUT_MS }, () => {
    it("ends each subscription unsubscribed when the client closes the stream", async () => {
        const fixture = await startFixture();
        const ids = await threeConversations(fixture);
        const reads = recordSubscriptionReads(fixture.catalogue);

        for (const [index, listener] of LISTENERS.entries()) {
            const stream = await fixture.openFeed(listener, idsQuery("conversations", ids));
            for (const _ of ids) assert.equal((await nextEvent(stream)).name, "snapshot");
            stream.close();

            const own = reads.slice(index * ids.length, (index + 1) * ids.length);
            assert.equal(own.length, ids.length, "one subscription per conversation");
            const lastReads = () => own.map((read) => read.at(-1));
            await eventuallyEqual(
                lastReads,
                ids.map(() => ({ closed: "unsubscribed" })),
                `the ${listener}'s subscriptions end`,
            );
        }
    });

    it("ends the others and sends one end with lagging when a stalled client leaves one subscription behind", async () => {
        const fixture = await startFixture(loopingReply);
        const [quiet, looping] = [await fixture.idleConversation("quiet"), await fixture.idleConversation("looping")];
        const reads = recordSubscriptionReads(fixture.catalogue);

        const stalled = await Promise.all(
            LISTENERS.map((listener) => fixture.openFeed(listener, idsQuery("conversations", [quiet, looping]))),
        );
        for (const stream of stalled) {
            await nextEvent(stream);
            await nextEvent(stream);
            stream.pause();
        }
        await fixture.submitAndSettle(looping, LOOP_INPUT);
        for (const stream of stalled) stream.resume();
        const endings = await Promise.all(stalled.map(readToEnd));

        assert.deepEqual(endings, [
            { last: LAGGING_END, how: "ended" },
            { last: LAGGING_END, how: "ended" },
        ]);
        await eventuallyEqual(
            () => reads.map((read) => read.at(-1)),
            reads.map(() => ({ closed: "unsubscribed" })),
            "no subscription stays open",
        );
    });

    it("ends the stream with stopped when the daemon shuts down", async () => {
        const fixture = await startFixture();
        const ids = await threeConversations(fixture);
        const open = await Promise.all(
            LISTENERS.map((listener) => fixture.openFeed(listener, idsQuery("conversations", ids))),
        );
        for (const stream of open) for (const _ of ids) await nextEvent(stream);

        await fixture.stop();

        assert.deepEqual(await Promise.all(open.map(readToEnd)), [
            { last: STOPPED_END, how: "ended" },
            { last: STOPPED_END, how: "ended" },
        ]);
    });
});
