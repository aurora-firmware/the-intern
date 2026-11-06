import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type ConversationId, defineEntry } from "@earendil-works/pi-durable";
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
import { type HarnessHost, type HostEntry, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { REPORT_KIND, type ReportRecord } from "../../src/host/reports.ts";
import { changeSeat, createSeatedConversation, type SeatActor } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND, steerConversation } from "../../src/host/steering.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { readEntriesPage } from "../../src/service/conversation_entries.ts";
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

const reportRecord: ReportRecord = {
    actor: { kind: "agent", conversationId: "7", role: "reviewer" },
    content: "the review is done",
};
const steerActor: SeatActor = { kind: "team_member", wayIn: "cli" };
const steerData = { actor: steerActor, mode: "followUp", content: "use the other approach" };

async function placeReport(host: HarnessHost, conversationId: string): Promise<void> {
    const { submissionId } = await submitInput(host, conversationId, {
        content: reportRecord.content,
        requestId: "report-request",
        busyMode: "followUp",
        entry: { kind: REPORT_KIND, data: reportRecord },
    });
    await waitForSubmission(host, submissionId, SUBMISSION_TIMEOUT_MS);
}

async function placeSteer(host: HarnessHost, conversationId: string): Promise<void> {
    const placed = await steerConversation(host, conversationId, {
        content: steerData.content,
        mode: "followUp",
        actor: steerActor,
        requestId: "steer-request",
    });
    assert.equal(placed.held, false);
    await waitForSubmission(host, placed.submissionId as string, SUBMISSION_TIMEOUT_MS);
}

const SEAT_ACTOR: SeatActor = { kind: "team_member", wayIn: "cli" };

function seatFor(fixture: Fixture, role: string): Seat {
    return { role, model: fixture.agentModel, workspace: process.cwd(), instructions: "Work.", tools: [], skills: [] };
}

async function createSeated(fixture: Fixture, role: string): Promise<string> {
    const { conversationId } = await createSeatedConversation(fixture.host, {
        scope: "conversation-feed-test",
        key: "k1",
        job: { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
        seat: seatFor(fixture, role),
        actor: SEAT_ACTOR,
    });
    return conversationId;
}

const NOTE_KIND = "test.note";
const noteEntry = defineEntry<{ text: string }>(NOTE_KIND);
const FILL_BATCH = 500;

async function appendNotes(host: HarnessHost, conversationId: string, count: number): Promise<void> {
    const id = Number(conversationId) as ConversationId;
    await internalHarness(host).commit(async (tx) => {
        for (let index = 0; index < count; index++) await tx.appendEntry(noteEntry, id, { data: { text: "note" } });
    }, BACKGROUND_CONTEXT);
}

async function fillEntries(host: HarnessHost, conversationId: string, count: number): Promise<void> {
    for (let done = 0; done < count; done += FILL_BATCH) {
        await appendNotes(host, conversationId, Math.min(FILL_BATCH, count - done));
    }
}

// The size of the one delta that a single short entry causes.
async function deltaBytesForOneEntry(fixture: Fixture, conversationId: string): Promise<number> {
    const subscription = await fixture.feed.subscribeConversation(conversationId);
    await appendNotes(fixture.host, conversationId, 1);
    const deltas = await collectUntil(subscription, (seen) => entriesOf(seen).length === 1);
    subscription.close();
    return deltas.reduce((total, delta) => total + JSON.stringify(delta).length, 0);
}

const entriesOf = (deltas: readonly ConversationDelta[]) => deltas.flatMap((delta) => delta.entries);

async function readAll(host: HarnessHost, conversationId: string, order: "ascending" | "descending" = "ascending") {
    return (await readEntriesPage(host, { conversationId, limit: 500, order })).entries;
}

function ownDataOf(entries: readonly HostEntry[], kind: string): unknown {
    return entries.find((entry) => entry.kind === kind)?.data;
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
    it("delivers a snapshot of the newest entry id and the state, with no entries", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");

        const subscription = await feed.subscribeConversation(conversationId);
        subscription.close();

        const newest = (await readAll(host, conversationId, "descending"))[0];
        assert.deepEqual(Object.keys(subscription.snapshot).sort(), ["busy", "inbox", "live", "newestEntryId"]);
        assert.equal(subscription.snapshot.newestEntryId, newest?.id);
        assert.equal(subscription.snapshot.busy, false);
    });

    it("gives a null newest entry id for a conversation with no entries", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });

        const subscription = await feed.subscribeConversation(conversationId);
        subscription.close();

        assert.equal(subscription.snapshot.newestEntryId, null);
    });

    it("delivers deltas in commit order with increasing sequence numbers, each holding only its commit's entries", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");

        const subscription = await feed.subscribeConversation(conversationId);
        await sendAndSettle(host, conversationId, "second");
        const deltas = await collectUntil(subscription, (seen) => JSON.stringify(entriesOf(seen)).includes('"ok"'));
        subscription.close();

        assert.deepEqual(
            deltas.map((delta) => delta.seq),
            deltas.map((_, index) => index + 1),
        );
        const added = (await readAll(host, conversationId)).filter(
            (entry) => Number(entry.id) > Number(subscription.snapshot.newestEntryId),
        );
        assert.deepEqual(entriesOf(deltas), added);
        for (const delta of deltas) {
            assert.deepEqual(Object.keys(delta).sort(), ["entries", "seq", "view"]);
            assert.deepEqual(Object.keys(delta.view).sort(), ["busy", "inbox", "live"]);
        }
    });

    it("gives a delta with empty entries for a commit that adds none", async () => {
        const { host, feed, agentModel } = await openFixture(RUN_DELAY_MS);
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const subscription = await feed.subscribeConversation(conversationId);

        await sendAndSettle(host, conversationId, "work");
        const deltas = await collectUntil(subscription, (seen) => JSON.stringify(entriesOf(seen)).includes('"ok"'));
        subscription.close();

        assert.ok(deltas.some((delta) => delta.entries.length === 0));
        assert.ok(deltas.every((delta) => !("ops" in delta)));
    });

    it("starts a new subscription from a fresh snapshot without replaying earlier deltas", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const first = await feed.subscribeConversation(conversationId);
        await sendAndSettle(host, conversationId, "first");
        await collectUntil(first, (seen) => JSON.stringify(entriesOf(seen)).includes('"ok"'));
        first.close();
        assert.deepEqual(await first.next(), { closed: "unsubscribed" });

        const second = await feed.subscribeConversation(conversationId);
        const newest = (await readAll(host, conversationId, "descending"))[0];
        assert.equal(second.snapshot.newestEntryId, newest?.id, "the fresh snapshot stands after the earlier commits");
        await sendAndSettle(host, conversationId, "second");
        const deltas = await collectUntil(second, (seen) => JSON.stringify(entriesOf(seen)).includes("second"));
        second.close();

        assert.equal(deltas[0]?.seq, 1, "the sequence starts again");
        assert.ok(!JSON.stringify(entriesOf(deltas)).includes("first"), "earlier entries are not replayed");
    });

    it("attributes each assistant entry in the deltas to the seat that produced it", async () => {
        const fixture = await openFixture();
        const conversationId = await createSeated(fixture, "developer");
        const subscription = await fixture.feed.subscribeConversation(conversationId);

        await sendAndSettle(fixture.host, conversationId, "one");
        await changeSeat(fixture.host, conversationId, { seat: seatFor(fixture, "reviewer"), actor: SEAT_ACTOR });
        await sendAndSettle(fixture.host, conversationId, "two");
        const deltas = await collectUntil(
            subscription,
            (seen) => entriesOf(seen).filter((entry) => entry.kind === "pi.assistant").length === 2,
        );
        subscription.close();

        const assistants = entriesOf(deltas).filter((entry) => entry.kind === "pi.assistant");
        assert.deepEqual(
            assistants.map((entry) => (entry as { seat?: { role: string } }).seat?.role),
            ["developer", "reviewer"],
        );
        const stored = await readAll(fixture.host, conversationId);
        assert.deepEqual(
            entriesOf(deltas),
            stored.filter((entry) => Number(entry.id) > Number(subscription.snapshot.newestEntryId)),
        );
    });

    it("takes the seat from the latest seat record in the view at subscription", async () => {
        const fixture = await openFixture();
        const conversationId = await createSeated(fixture, "developer");
        await changeSeat(fixture.host, conversationId, { seat: seatFor(fixture, "reviewer"), actor: SEAT_ACTOR });
        const subscription = await fixture.feed.subscribeConversation(conversationId);

        await sendAndSettle(fixture.host, conversationId, "one");
        const deltas = await collectUntil(subscription, (seen) =>
            entriesOf(seen).some((entry) => entry.kind === "pi.assistant"),
        );
        subscription.close();

        const assistant = entriesOf(deltas).find((entry) => entry.kind === "pi.assistant");
        assert.equal((assistant as { seat?: { role: string } }).seat?.role, "reviewer");
    });

    it("sends a delta no larger for one short entry in 2000 entries than in 20", async () => {
        const fixture = await openFixture();
        const small = await fixture.host.createConversation({ agent: { model: fixture.agentModel } });
        const large = await fixture.host.createConversation({ agent: { model: fixture.agentModel } });
        await fillEntries(fixture.host, small, 20);
        await fillEntries(fixture.host, large, 2000);

        const smallBytes = await deltaBytesForOneEntry(fixture, small);
        const largeBytes = await deltaBytesForOneEntry(fixture, large);

        assert.ok(smallBytes > 0);
        assert.ok(largeBytes <= smallBytes, `${largeBytes} bytes for 2000 entries, ${smallBytes} for 20`);
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

    it("shows an intern.report entry in a delta by its stored actor and content", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const subscription = await feed.subscribeConversation(conversationId);
        await placeReport(host, conversationId);
        const deltas = await collectUntil(subscription, (seen) =>
            entriesOf(seen).some((entry) => entry.kind === REPORT_KIND),
        );
        subscription.close();

        assert.deepEqual(ownDataOf(entriesOf(deltas), REPORT_KIND), reportRecord);
    });

    it("shows an intern.steer entry in a delta by its stored actor, mode and content", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const subscription = await feed.subscribeConversation(conversationId);
        await placeSteer(host, conversationId);
        const deltas = await collectUntil(subscription, (seen) =>
            entriesOf(seen).some((entry) => entry.kind === STEER_RECORD_KIND),
        );
        subscription.close();

        assert.deepEqual(ownDataOf(entriesOf(deltas), STEER_RECORD_KIND), steerData);
    });

    it("shows every delta entry as conversations.entries shows it", async () => {
        const { host, feed, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const subscription = await feed.subscribeConversation(conversationId);

        await sendAndSettle(host, conversationId, "hello");
        await placeReport(host, conversationId);
        await placeSteer(host, conversationId);
        const stored = await readAll(host, conversationId);
        const deltas = await collectUntil(subscription, (seen) => entriesOf(seen).length >= stored.length);
        subscription.close();

        const kinds = entriesOf(deltas).map((entry) => entry.kind);
        assert.ok(["pi.user", "pi.assistant", REPORT_KIND, STEER_RECORD_KIND].every((kind) => kinds.includes(kind)));
        assert.deepEqual(entriesOf(deltas), stored);
    });
});
