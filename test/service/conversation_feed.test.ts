import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    type ConversationDelta,
    createObservationFeed,
    createSubscription,
    FEED_MAX_PENDING,
    type ObservationFeed,
    type Subscription,
} from "../../src/feed/observation_feed.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, type HostEntry, openHarnessHost } from "../../src/host/harness_host.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const RUN_DELAY_MS = 150;
const SUBMISSION_TIMEOUT_MS = 10_000;
const NEXT_TIMEOUT_MS = 5000;

type FakeModel = ReturnType<typeof createFakeModel>;
type Fixture = { host: HarnessHost; feed: ObservationFeed; agentModel: string };
type Next = Awaited<ReturnType<Subscription<unknown, ConversationDelta>["next"]>>;

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const feeds: ObservationFeed[] = [];

afterEach(async () => {
    for (const feed of feeds.splice(0)) feed.close();
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function modelsFor(fake: FakeModel): Models {
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation, "the fake model's api is registered");
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return models;
}

async function openFixture(delayMs = 0): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => delayMs });
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const feed = createObservationFeed({ host });
    feeds.push(feed);
    return { host, feed, agentModel: `${fake.getModel().provider}/${fake.getModel().id}` };
}

async function sendAndSettle(host: HarnessHost, conversationId: string, content: string): Promise<void> {
    const { submissionId } = await submitInput(host, conversationId, {
        content,
        requestId: `req-${content}`,
        busyMode: "followUp",
    });
    await waitForSubmission(host, submissionId, SUBMISSION_TIMEOUT_MS);
}

async function nextWithin(subscription: Subscription<unknown, ConversationDelta>): Promise<Next> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for the next delta")), NEXT_TIMEOUT_MS);
    });
    try {
        return await Promise.race([subscription.next(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function collectUntil(
    subscription: Subscription<unknown, ConversationDelta>,
    isDone: (deltas: ConversationDelta[]) => boolean,
): Promise<ConversationDelta[]> {
    const deltas: ConversationDelta[] = [];
    while (!isDone(deltas)) {
        const result = await nextWithin(subscription);
        assert.ok("delta" in result, "the subscription stays open");
        deltas.push(result.delta);
    }
    return deltas;
}

describe("createSubscription", () => {
    it("delivers pushed deltas in order and resolves a waiting reader", async () => {
        const { subscription, push } = createSubscription<string, number>("snap");
        const waiting = subscription.next();
        push(1);
        push(2);
        assert.equal(subscription.snapshot, "snap");
        assert.deepEqual(await waiting, { delta: 1 });
        assert.deepEqual(await subscription.next(), { delta: 2 });
    });

    it("closes with reason lagging when more than the default 1000 deltas are undelivered", async () => {
        const { subscription, push } = createSubscription<string, number>("snap");
        for (let index = 0; index < FEED_MAX_PENDING; index++) push(index);
        push(FEED_MAX_PENDING);
        assert.deepEqual(await subscription.next(), { closed: "lagging" });
        assert.deepEqual(await subscription.next(), { closed: "lagging" });
    });

    it("keeps a subscriber with exactly maxPending undelivered deltas open", async () => {
        const { subscription, push } = createSubscription<string, number>("snap", 3);
        push(1);
        push(2);
        push(3);
        assert.deepEqual(await subscription.next(), { delta: 1 });
    });

    it("closes a waiting reader with the reason given to end", async () => {
        const { subscription, end } = createSubscription<string, number>("snap");
        const waiting = subscription.next();
        end("stopped");
        assert.deepEqual(await waiting, { closed: "stopped" });
    });

    it("closes with reason unsubscribed when the subscriber closes and ignores later pushes", async () => {
        const { subscription, push } = createSubscription<string, number>("snap");
        subscription.close();
        push(1);
        assert.deepEqual(await subscription.next(), { closed: "unsubscribed" });
    });
});

describe("conversation observation feed", () => {
    it("delivers the snapshot and then deltas in commit order with increasing sequence numbers", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");

        const subscription = await feed.subscribeConversation(conversationId);
        assert.ok(subscription.snapshot.entries.length > 0, "the snapshot holds the view at subscription");
        assert.equal(subscription.snapshot.busy, false);
        assert.ok("inbox" in subscription.snapshot, "the snapshot carries the queued input");
        await sendAndSettle(host, conversationId, "second");
        const deltas = await collectUntil(subscription, (seen) =>
            JSON.stringify(seen.at(-1)?.view ?? null).includes("second"),
        );
        subscription.close();

        assert.deepEqual(
            deltas.map((delta) => delta.seq),
            deltas.map((_, index) => index + 1),
        );
        let previousLength = subscription.snapshot.entries.length;
        for (const delta of deltas) {
            assert.ok(delta.view.entries.length >= previousLength, "each delta extends the one before");
            assert.ok(delta.ops.length > 0);
            previousLength = delta.view.entries.length;
        }
    });

    it("starts a new subscription from a fresh snapshot without replaying earlier deltas", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const first = await feed.subscribeConversation(conversationId);
        await sendAndSettle(host, conversationId, "first");
        await collectUntil(first, (seen) => JSON.stringify(seen.at(-1)?.view ?? null).includes("first"));
        first.close();
        assert.deepEqual(await first.next(), { closed: "unsubscribed" });

        const second = await feed.subscribeConversation(conversationId);
        assert.ok(JSON.stringify(second.snapshot).includes("first"), "the fresh snapshot holds the earlier commits");
        await sendAndSettle(host, conversationId, "second");
        const deltas = await collectUntil(second, (seen) =>
            JSON.stringify(seen.at(-1)?.view ?? null).includes("second"),
        );
        second.close();

        assert.equal(deltas[0]?.seq, 1, "the sequence starts again");
        assert.ok(deltas.every((delta) => delta.view.entries.length >= second.snapshot.entries.length));
    });

    it("rejects subscribing to a conversation that does not exist", async () => {
        const { feed } = await openFixture();
        await assert.rejects(feed.subscribeConversation("999"), /does not exist/);
    });

    it("closes every subscription with reason stopped when the feed closes", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const subscription = await feed.subscribeConversation(conversationId);
        const waiting = subscription.next();
        feed.close();
        assert.deepEqual(await waiting, { closed: "stopped" });
    });

    it("rejects a subscription requested after the feed closed", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        feed.close();
        await assert.rejects(feed.subscribeConversation(conversationId), /feed is closed/);
    });

    it("rejects a subscription that was still being created when the feed closed", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const pendingSubscription = feed.subscribeConversation(conversationId);
        feed.close();
        await assert.rejects(pendingSubscription, /feed is closed/);
    });

    it("completes a run with the same entries whether or not a subscriber reads", async () => {
        const withoutSubscriber = await openFixture(RUN_DELAY_MS);
        const controlId = await withoutSubscriber.host.createConversation({
            agent: { model: withoutSubscriber.agentModel },
        });
        await sendAndSettle(withoutSubscriber.host, controlId, "work");
        const expected = await withoutSubscriber.host.readEntries(controlId, { limit: 100 });

        const withSubscriber = await openFixture(RUN_DELAY_MS);
        const observedId = await withSubscriber.host.createConversation({
            agent: { model: withSubscriber.agentModel },
        });
        const idle = await withSubscriber.feed.subscribeConversation(observedId);
        await sendAndSettle(withSubscriber.host, observedId, "work");
        const actual = await withSubscriber.host.readEntries(observedId, { limit: 100 });
        idle.close();

        // Timestamps, durations and fake api names differ between two runs; the kinds and the message text do not.
        const shape = (entries: HostEntry[]): unknown[] =>
            entries.map((entry) => [entry.kind, JSON.stringify(entry.data).match(/"text":"[^"]*"/g)]);
        assert.deepEqual(shape(actual.entries), shape(expected.entries));
    });

    it("closes a subscriber that reads nothing with reason lagging and leaves the run unaffected", async () => {
        const { host, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const lagging = createObservationFeed({ host, maxPending: 1 });
        feeds.push(lagging);
        const idle = await lagging.subscribeConversation(conversationId);
        await sendAndSettle(host, conversationId, "work");
        assert.deepEqual(await nextWithin(idle), { closed: "lagging" });
        const { entries } = await host.readEntries(conversationId, { limit: 100 });
        assert.ok(JSON.stringify(entries).includes('"text":"ok"'), "the run completed");
    });
});
