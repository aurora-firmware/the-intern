/**
 * The feed and long calls through both listeners of a real daemon (S-003 REQ-006, REQ-011, REQ-012): `GET /feed`
 * streams a snapshot and then deltas over Server-Sent Events, a client that stops reading is ended `lagging` without
 * touching the run, and neither a quiet stream nor a long `submissions.wait` is cut short by the listener.
 */
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { IncomingMessage, OutgoingHttpHeaders, Server } from "node:http";
import { afterEach, describe, it, mock } from "node:test";
import { MAX_SUBMISSION_WAIT_MS } from "../../src/daemon/constants.ts";
import { LISTENER_TIMEOUT_MS } from "../../src/listeners/listener_server.ts";
import type { FakeTranscript } from "../support/fake_model.ts";
import {
    disposeFixtures,
    type Entry,
    eventuallyEqual,
    type FeedEvent,
    type FeedStream,
    type Fixture,
    LAGGING_END,
    LISTENERS,
    type Listener,
    LOOP_INPUT,
    loopingReply,
    nextEvent,
    readToEnd,
    recordSubscriptionReads,
    startFixture,
    type View,
} from "../support/listeners_feed_fixture.ts";

const TEST_TIMEOUT_MS = 90_000;
/**
 * The bound a run with a stalled subscriber must finish in, relative to the same run with none: generous enough for a
 * loaded machine, far below a run that waits on its subscriber.
 */
const RUN_TIME_FACTOR = 2;
const RUN_TIME_MARGIN_MS = 2000;
/** Node's default `keepAliveTimeout`, the idle timeout a listener left at its defaults would apply. */
const NODE_DEFAULT_IDLE_TIMEOUT_MS = 5000;
/** Longer than Node's default idle timeout; the full 5-minute wait is not run in `npm test`. */
const LONG_WAIT_MS = 6000;
const HOLD_INPUT = "hold";
/** Longer than the test; stopping the daemon aborts the held answer. */
const HOLD_DELAY_MS = 120_000;
const TAG_HEADER = "x-test-request";
const REQUEST_START_CHANNEL = "http.server.request.start";

const recorders: { stop(): void }[] = [];

afterEach(async () => {
    mock.restoreAll();
    for (const recorder of recorders.splice(0)) recorder.stop();
    await disposeFixtures();
});

/** Holds the answer to `HOLD_INPUT` back for `HOLD_DELAY_MS`; any other input is answered at once. */
function holdingDelay(transcript: FakeTranscript): number {
    return transcript.findLast((message) => message.role === "user")?.text === HOLD_INPUT ? HOLD_DELAY_MS : 0;
}

/** Reads `delta` events until the conversation has been seen busy and then idle again. */
async function readDeltasUntilSettled(stream: FeedStream): Promise<FeedEvent[]> {
    const deltas: FeedEvent[] = [];
    let hasSeenBusy = false;
    for (;;) {
        const event = await nextEvent(stream);
        assert.equal(event.name, "delta", `event ${JSON.stringify(event).slice(0, 200)} is a delta`);
        deltas.push(event);
        const { busy } = (event.data as { view: View }).view;
        if (hasSeenBusy && !busy) return deltas;
        hasSeenBusy ||= busy;
    }
}

/** Asserts the deltas carry ids 1, 2, 3 … equal to their sequence numbers. */
function assertCommitOrder(deltas: readonly FeedEvent[]): void {
    assert.deepEqual(
        deltas.map((delta) => delta.id),
        deltas.map((_, index) => index + 1),
    );
    for (const delta of deltas) {
        const { seq } = delta.data as { seq: number };
        assert.equal(seq, delta.id, "the event id is the delta's sequence number");
    }
}

/**
 * Opens the conversation feed, lets a run commit `content`, and returns the history the conversation held when the
 * snapshot arrived, the history after the run, and the deltas read.
 */
async function observeRun(fixture: Fixture, listener: Listener, conversationId: string, content: string) {
    const stream = await fixture.openFeed(listener, `?scope=conversation&id=${conversationId}`);
    assert.equal(stream.status, 200);
    const first = await nextEvent(stream);
    assert.equal(first.name, "snapshot");
    const historyAtSnapshot = JSON.stringify(await fixture.entries(conversationId));
    await fixture.submitAndSettle(conversationId, content);
    const deltas = await readDeltasUntilSettled(stream);
    stream.close();
    const historyAfterRun = JSON.stringify(await fixture.entries(conversationId));
    return { historyAtSnapshot, historyAfterRun, deltas };
}

describe("the conversation feed through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`starts each stream over the ${listener} with a fresh snapshot, then deltas in commit order`, async () => {
            const fixture = await startFixture();
            const conversationId = await fixture.idleConversation("observed");

            const first = await observeRun(fixture, listener, conversationId, "first run");
            const second = await observeRun(fixture, listener, conversationId, "second run");

            assertCommitOrder(first.deltas);
            assertCommitOrder(second.deltas);
            assert.ok(!first.historyAtSnapshot.includes("first run"), "the first snapshot precedes its run");
            assert.ok(first.historyAfterRun.includes("first run"), "the first run committed its input");
            assert.ok(second.historyAtSnapshot.includes("first run"), "the second snapshot is fresh");
            assert.ok(second.historyAfterRun.includes("second run"), "the second run committed its input");
            assert.equal(second.deltas[0]?.id, 1, "the second stream replays no delta from before its snapshot");
        });
    }
});

type InstanceConversation = {
    id: string;
    jobId: string | null;
    isLead: boolean;
    seat: { role: string } | null;
    status: string;
};
type InstanceSnapshot = { conversations: InstanceConversation[]; workerThreads: { count: number; inUse: number } };
type InstanceDelta = { seq: number; type: string; conversationId?: string; seat?: { role: string } };

/** Reads `delta` events until one has the type `last`. */
async function readInstanceDeltasUntil(stream: FeedStream, last: string): Promise<FeedEvent[]> {
    const deltas: FeedEvent[] = [];
    for (;;) {
        const event = await nextEvent(stream);
        assert.equal(event.name, "delta");
        deltas.push(event);
        if ((event.data as InstanceDelta).type === last) return deltas;
    }
}

describe("the instance feed through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("streams over both listeners the snapshot and the deltas the in-process subscription gets", async () => {
        const fixture = await startFixture();
        const alpha = await fixture.idleConversation("alpha");
        const beta = await fixture.idleConversation("beta");
        const inProcess = (await fixture.invoke("feed.subscribe", { scope: "instance" })) as {
            snapshot: InstanceSnapshot;
            close(): void;
        };
        inProcess.close();
        const opened = await Promise.all(LISTENERS.map((listener) => fixture.openFeed(listener, "?scope=instance")));
        const snapshots = await Promise.all(opened.map(nextEvent));

        const gamma = await fixture.idleConversation("gamma");
        await fixture.invoke("conversations.seat", { conversationId: alpha, role: "gp" });
        await fixture.invoke("roles.create", { name: "watched", instructions: "Watch.", tools: ["read"], skills: [] });
        const [overSocket, overNetwork] = await Promise.all(
            opened.map((stream) => readInstanceDeltasUntil(stream, "settings_changed")),
        );

        for (const snapshot of snapshots) {
            assert.equal(snapshot.name, "snapshot");
            assert.deepEqual(snapshot.data, inProcess.snapshot);
        }
        const { conversations, workerThreads } = inProcess.snapshot;
        const byJob = Object.fromEntries(conversations.map(({ id, jobId, isLead }) => [jobId, { id, isLead }]));
        assert.deepEqual(byJob, {
            [fixture.jobIdOf(alpha)]: { id: alpha, isLead: true },
            [fixture.jobIdOf(beta)]: { id: beta, isLead: true },
        });
        assert.ok(conversations.every(({ seat, status }) => seat?.role === "bob" && status === "idle"));
        assert.equal(workerThreads.inUse, 0);
        assert.deepEqual(overNetwork, overSocket, "both listeners deliver the same deltas");
        assertInstanceDeltas(overSocket ?? [], { gamma, alpha });
    });
});

function assertInstanceDeltas(events: readonly FeedEvent[], ids: { gamma: string; alpha: string }): void {
    const deltas = events.map((event) => event.data as InstanceDelta);
    assert.deepEqual(
        events.map((event) => event.id),
        deltas.map((delta) => delta.seq),
    );
    assert.deepEqual(
        deltas.map((delta) => delta.seq),
        deltas.map((_, index) => index + 1),
    );
    const indexOf = (type: string, conversationId?: string) =>
        deltas.findIndex(
            (delta) => delta.type === type && (!conversationId || delta.conversationId === conversationId),
        );
    assert.equal(indexOf("conversation_created"), indexOf("conversation_created", ids.gamma));
    assert.ok(indexOf("conversation_created", ids.gamma) < indexOf("run_started", ids.gamma));
    assert.ok(indexOf("run_started", ids.gamma) < indexOf("run_finished", ids.gamma));
    assert.ok(indexOf("admission_changed") >= 0, "admission changes are reported");
    assert.ok(indexOf("run_finished", ids.gamma) < indexOf("seat_changed", ids.alpha));
    assert.equal(deltas[indexOf("seat_changed", ids.alpha)]?.seat?.role, "gp");
    assert.equal(indexOf("settings_changed"), deltas.length - 1);
}

async function timed(action: () => Promise<void>): Promise<number> {
    const startedAt = performance.now();
    await action();
    return performance.now() - startedAt;
}

/** The entries from the loop's input on, without what differs between two runs: times, ids and usage. */
function loopShape(entries: readonly Entry[]): unknown[] {
    const loopStart = entries.findIndex((entry) => JSON.stringify(entry.data).includes(`"${LOOP_INPUT}"`));
    assert.ok(loopStart >= 0, "the conversation holds the loop's input");
    return entries
        .slice(loopStart)
        .map((entry) => [entry.kind, JSON.stringify(entry.data).match(/"(text|arguments)":("[^"]*"|\{[^}]*\})/g)]);
}

describe("a feed client that stops reading", { timeout: TEST_TIMEOUT_MS }, () => {
    it("ends the stalled stream over each listener with lagging and leaves the run's time and entries alone", async () => {
        const fixture = await startFixture(loopingReply);
        const control = await fixture.idleConversation("control");
        const observed = await fixture.idleConversation("observed");
        const controlTime = await timed(() => fixture.submitAndSettle(control, LOOP_INPUT));

        const query = `?scope=conversation&id=${observed}`;
        const stalled = await Promise.all(LISTENERS.map((listener) => fixture.openFeed(listener, query)));
        for (const stream of stalled) {
            assert.equal((await nextEvent(stream)).name, "snapshot");
            stream.pause();
        }
        const observedTime = await timed(() => fixture.submitAndSettle(observed, LOOP_INPUT));
        for (const stream of stalled) stream.resume();
        const endings = await Promise.all(stalled.map(readToEnd));

        assert.deepEqual(endings, [
            { last: LAGGING_END, how: "ended" },
            { last: LAGGING_END, how: "ended" },
        ]);
        const bound = controlTime * RUN_TIME_FACTOR + RUN_TIME_MARGIN_MS;
        assert.ok(observedTime <= bound, `the run took ${observedTime} ms, the bound is ${bound} ms`);
        assert.deepEqual(loopShape(await fixture.entries(observed)), loopShape(await fixture.entries(control)));
    });
});

/** The server that took each tagged request, heard on Node's `http.server.request.start` diagnostics channel. */
function recordServers(): { serverOf(tag: string): Server; stop(): void } {
    const servers = new Map<string, Server>();
    const onRequest = (message: unknown) => {
        const { request: incoming, server } = message as { request: IncomingMessage; server: Server };
        const tag = incoming.headers[TAG_HEADER];
        if (typeof tag === "string") servers.set(tag, server);
    };
    subscribe(REQUEST_START_CHANNEL, onRequest);
    const recorder = {
        serverOf(tag: string) {
            const server = servers.get(tag);
            assert.ok(server, `a server took the request tagged ${tag}`);
            return server;
        },
        stop: () => unsubscribe(REQUEST_START_CHANNEL, onRequest),
    };
    recorders.push(recorder);
    return recorder;
}

const tagged = (tag: string): OutgoingHttpHeaders => ({ [TAG_HEADER]: tag });

/** Reads `delta` events until the conversation has been seen busy and then idle again. */
async function readDeltasUntilRunEnds(stream: FeedStream): Promise<void> {
    let hasSeenBusy = false;
    for (;;) {
        const event = await nextEvent(stream);
        assert.equal(event.name, "delta");
        const { busy } = (event.data as { view: View }).view;
        if (hasSeenBusy && !busy) return;
        hasSeenBusy ||= busy;
    }
}

describe("long calls through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("keeps a read feed stream and a 6-second submissions.wait open past Node's default idle timeout", async () => {
        const recorded = recordServers();
        const fixture = await startFixture(() => "ok", { delayMs: holdingDelay });
        const conversationId = await fixture.idleConversation("held");
        const query = `?scope=conversation&id=${conversationId}`;
        const feeds = await Promise.all(LISTENERS.map((way) => fixture.openFeed(way, query, tagged(`feed ${way}`))));
        for (const stream of feeds) assert.equal((await nextEvent(stream)).name, "snapshot");
        const hold = { conversationId, content: HOLD_INPUT, requestId: "hold-request" };
        const { submissionId } = (await fixture.invoke("conversations.submit", hold)) as { submissionId: string };

        const wait = { submissionId, timeoutMs: LONG_WAIT_MS };
        const waitedFor = await timed(async () => {
            const answers = await Promise.all(
                LISTENERS.map((way) => fixture.post(way, "submissions.wait", wait, tagged(`wait ${way}`))),
            );
            for (const answer of answers) {
                assert.equal(answer.status, 200, `the wait is answered, not cut: ${JSON.stringify(answer.body)}`);
                assert.equal((answer.body.result as { state: string }).state, "running");
            }
        });
        await fixture.invoke("conversations.abort", { conversationId });
        await Promise.all(feeds.map(readDeltasUntilRunEnds));

        assert.ok(waitedFor >= LONG_WAIT_MS && LONG_WAIT_MS > NODE_DEFAULT_IDLE_TIMEOUT_MS, `waited ${waitedFor} ms`);
        assert.ok(LISTENER_TIMEOUT_MS > MAX_SUBMISSION_WAIT_MS, "the timeouts outlast the longest wait");
        for (const way of LISTENERS) {
            const server = recorded.serverOf(`wait ${way}`);
            assert.equal(recorded.serverOf(`feed ${way}`), server, `one server serves the ${way}`);
            assert.equal(server.requestTimeout, LISTENER_TIMEOUT_MS, `the ${way}'s request timeout`);
            assert.equal(server.timeout, LISTENER_TIMEOUT_MS, `the ${way}'s idle timeout`);
        }
        assert.notEqual(recorded.serverOf("wait local socket"), recorded.serverOf("wait network listener"));
    });
});

function openConnections(server: Server): Promise<number> {
    return new Promise((resolve, reject) =>
        server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
    );
}

describe("refused and closed feeds through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("refuses a feed with no scope as invalid_input and an unknown conversation as not_found", async () => {
        const fixture = await startFixture();
        const unknown = { scope: "conversation", conversationId: "999" };
        const inProcess = await fixture.invoke("feed.subscribe", unknown).then(
            () => assert.fail("subscribing to an unknown conversation in-process is refused"),
            (error: { code: string; message: string }) => ({ code: error.code, message: error.message }),
        );

        for (const listener of LISTENERS) {
            const noScope = await fixture.openFeed(listener, "");
            const unknownId = await fixture.openFeed(listener, "?scope=conversation&id=999");

            assert.equal(noScope.status, 400, `no scope over the ${listener}`);
            assert.equal((await noScope.refusal()).error?.code, "invalid_input");
            assert.equal(unknownId.status, 404, `an unknown conversation over the ${listener}`);
            assert.deepEqual((await unknownId.refusal()).error, inProcess);
        }
    });

    it("ends the subscription as unsubscribed and holds no connection once the client closes", async () => {
        const recorded = recordServers();
        const fixture = await startFixture();
        const conversationId = await fixture.idleConversation("closed");
        const reads = recordSubscriptionReads(fixture.catalogue);

        for (const [index, listener] of LISTENERS.entries()) {
            const query = `?scope=conversation&id=${conversationId}`;
            const stream = await fixture.openFeed(listener, query, tagged(`closed ${listener}`));
            assert.equal((await nextEvent(stream)).name, "snapshot");
            stream.close();

            const server = recorded.serverOf(`closed ${listener}`);
            const lastRead = async () => reads[index]?.at(-1);
            await eventuallyEqual(lastRead, { closed: "unsubscribed" }, `the ${listener}'s subscription ends`);
            await eventuallyEqual(() => openConnections(server), 0, `the ${listener} holds no connection`);
        }
    });
});
