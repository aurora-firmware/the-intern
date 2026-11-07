/**
 * The client library's subscription to several conversations over both listeners of a real daemon (S-003 REQ-009,
 * AC-009.4): one request, each conversation's snapshot and deltas in order with its conversation id, and the end
 * `stopped` with no new subscription.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createClient } from "../../src/client/client.ts";
import { nodeTransport } from "../../src/client/node_transport.ts";
import {
    cleanupFixtures,
    idleConversation,
    LISTENERS,
    readUntilEnd,
    startFixture,
    TEST_TIMEOUT_MS,
} from "../support/client_fixture.ts";

afterEach(async () => {
    mock.restoreAll();
    await cleanupFixtures();
});

type ConversationDelta = { conversationId: string; delta: { seq: number } };

describe("a subscription to several conversations through the client", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`opens one request, yields each conversation's items in order, and ends stopped over the ${listener}`, async () => {
            const fixture = await startFixture();
            const ids = [
                await idleConversation(fixture, listener, "alpha"),
                await idleConversation(fixture, listener, "beta"),
            ];
            const inner = nodeTransport(
                listener === "local socket"
                    ? { socketPath: fixture.targetOf(listener) }
                    : { baseUrl: fixture.targetOf(listener) },
            );
            const streams: string[] = [];
            const client = createClient({
                call: (name, input) => inner.call(name, input),
                stream: (path) => {
                    streams.push(path);
                    return inner.stream(path);
                },
            });
            const feed = client.subscribeConversations(ids);

            const snapshots = [await feed.next(), await feed.next()];
            await Promise.all(
                ids.map((id, index) =>
                    fixture.invoke("conversations.submit", {
                        conversationId: id,
                        content: "go",
                        requestId: `request-${index}`,
                    }),
                ),
            );
            const seen = new Map<string, number[]>(ids.map((id) => [id, []]));
            while ([...seen.values()].some((seqs) => seqs.length < 2)) {
                const read = await feed.next();
                assert.ok(!read.done && "delta" in read.value, `a delta follows, not ${JSON.stringify(read)}`);
                const { conversationId, delta } = read.value as ConversationDelta;
                seen.get(conversationId)?.push(delta.seq);
            }
            const [rest] = await Promise.all([readUntilEnd(feed), fixture.daemon.stop()]);
            const afterEnd = await feed.next();

            assert.deepEqual(
                snapshots.map((read) => !read.done && "snapshot" in read.value && read.value.conversationId).sort(),
                [...ids].sort(),
            );
            for (const seqs of seen.values()) assert.deepEqual(seqs.slice(0, 2), [1, 2]);
            assert.deepEqual(rest.end, { end: "stopped" });
            assert.deepEqual(afterEnd, { done: true, value: undefined }, "the ended subscription stays ended");
            assert.deepEqual(streams, [`/feed?scope=conversations&id=${ids[0]}&id=${ids[1]}`], "one request only");
        });
    }
});
