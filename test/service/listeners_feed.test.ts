/**
 * The feed and long calls through both listeners of a real daemon (S-003 REQ-006, REQ-011, REQ-012): `GET /feed`
 * streams a snapshot and then deltas over Server-Sent Events, a client that stops reading is ended `lagging` without
 * touching the run, and neither a quiet stream nor a long `submissions.wait` is cut short by the listener.
 */
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { writeFile } from "node:fs/promises";
import { type IncomingMessage, type OutgoingHttpHeaders, request, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { MAX_SUBMISSION_WAIT_MS, STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { LISTENER_TIMEOUT_MS } from "../../src/listeners/listener_server.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller, Catalogue } from "../../src/service/operations.ts";
import { createFakeModel, type FakeModelOptions, type FakeReply, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const SETTLE_WAIT_MS = 30_000;
const EVENT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 90_000;
const ENTRIES_PAGE_LIMIT = 500;
const LOOPBACK = "127.0.0.1";
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
const quietLogger = createLogger({ stream: { write: () => true } });
const LISTENERS = ["local socket", "network listener"] as const;
/** About three commits per step, so a run of this many steps produces well over the 1000 deltas of the bound. */
const LOOP_STEPS = 450;
const LOOP_INPUT = "loop";
/**
 * The bound a run with a stalled subscriber must finish in, relative to the same run with none: generous enough for a
 * loaded machine, far below a run that waits on its subscriber.
 */
const RUN_TIME_FACTOR = 2;
const RUN_TIME_MARGIN_MS = 2000;
const LAGGING_END: FeedEvent = { name: "end", data: { reason: "lagging" } };
/** Node's default `keepAliveTimeout`, the idle timeout a listener left at its defaults would apply. */
const NODE_DEFAULT_IDLE_TIMEOUT_MS = 5000;
/** Longer than Node's default idle timeout; the full 5-minute wait is not run in `npm test`. */
const LONG_WAIT_MS = 6000;
const HOLD_INPUT = "hold";
/** Holds the answer to `HOLD_INPUT` past the end of the test; stopping the daemon aborts it. */
const HOLD_DELAY_MS = 120_000;
const TAG_HEADER = "x-test-request";
const JSON_HEADERS: OutgoingHttpHeaders = { "content-type": "application/json" };
const REQUEST_START_CHANNEL = "http.server.request.start";

type Listener = (typeof LISTENERS)[number];
type HttpTarget = { socketPath: string } | { host: string; port: number };
type Entry = { kind: string; data: unknown };
type View = { entries: Entry[]; busy: boolean };
type FeedEvent = { name: string; id?: number; data: unknown };
type AnswerBody = { result?: unknown; error?: { code: string; message?: string } };
type Answer = { status: number; body: AnswerBody };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];
const streams: FeedStream[] = [];
const recorders: { stop(): void }[] = [];

afterEach(async () => {
    mock.restoreAll();
    for (const recorder of recorders.splice(0)) recorder.stop();
    for (const stream of streams.splice(0)) stream.close();
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

/** Parses one Server-Sent Event block: `event:`, an optional `id:` and one `data:` line holding JSON. */
function parseEvent(block: string): FeedEvent {
    const fields = new Map(
        block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
    );
    const id = fields.get("id");
    return {
        name: fields.get("event") ?? "",
        ...(id !== undefined && { id: Number(id) }),
        data: JSON.parse(fields.get("data") ?? "null"),
    };
}

/** What `FeedStream.next` resolves: an event, the server having ended the stream, or no event within the wait. */
type FeedRead = FeedEvent | "ended" | "silent";

/** A `GET /feed` stream read event by event. */
type FeedStream = {
    status: number;
    /** The JSON body of a refused subscription. */
    refusal(): Promise<AnswerBody>;
    next(): Promise<FeedRead>;
    pause(): void;
    resume(): void;
    close(): void;
};

function openFeedAt(target: HttpTarget, query: string, headers: OutgoingHttpHeaders): Promise<FeedStream> {
    return new Promise((resolve, reject) => {
        const options = { ...target, method: "GET", path: `/feed${query}`, headers, agent: false };
        const call = request(options, (response) => {
            resolve(readFeed(response, () => call.destroy()));
        });
        call.once("error", reject);
        call.end();
    });
}

function readJson(response: IncomingMessage): Promise<AnswerBody> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        response.once("error", reject);
    });
}

/** Calls an operation; a connection the listener cuts is answered with status 0 and the connection error. */
function post(target: HttpTarget, name: string, input: unknown, headers: OutgoingHttpHeaders): Promise<Answer> {
    return new Promise((resolve) => {
        const options = {
            ...target,
            method: "POST",
            path: `/operations/${name}`,
            headers: { ...JSON_HEADERS, ...headers },
        };
        const call = request(options, (response) => {
            readJson(response).then((body) => resolve({ status: response.statusCode ?? 0, body }));
        });
        call.once("error", (error) =>
            resolve({ status: 0, body: { error: { code: "connection", message: error.message } } }),
        );
        call.end(JSON.stringify(input));
    });
}

function readFeed(response: IncomingMessage, destroy: () => void): FeedStream {
    const status = response.statusCode ?? 0;
    const refusal = status === 200 ? undefined : readJson(response);
    const events: FeedEvent[] = [];
    let buffered = "";
    let hasEnded = false;
    let wake: (() => void) | undefined;
    if (refusal === undefined) {
        response.on("data", (chunk: Buffer) => {
            buffered += chunk.toString("utf8");
            const blocks = buffered.split("\n\n");
            buffered = blocks.pop() ?? "";
            for (const block of blocks) events.push(parseEvent(block));
            wake?.();
        });
    }
    const markEnded = () => {
        hasEnded = true;
        wake?.();
    };
    response.once("end", markEnded);
    response.once("close", markEnded);

    function waitForData(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(settle, ms);
            function settle(): void {
                clearTimeout(timer);
                wake = undefined;
                resolve();
            }
            wake = settle;
        });
    }

    async function next(): Promise<FeedRead> {
        const deadline = Date.now() + EVENT_TIMEOUT_MS;
        while (events.length === 0 && !hasEnded && Date.now() < deadline) await waitForData(deadline - Date.now());
        return events.shift() ?? (hasEnded ? "ended" : "silent");
    }

    return {
        status,
        refusal: () => refusal ?? Promise.reject(new Error(`the feed was not refused: status ${status}`)),
        next,
        pause: () => response.pause(),
        resume: () => response.resume(),
        close: destroy,
    };
}

/**
 * Answers `LOOP_INPUT` with `LOOP_STEPS` calls to a tool that does not exist, each answered by an error result, and
 * then with text; any other input is answered with text at once.
 */
function loopingReply(transcript: FakeTranscript): FakeReply {
    const userIndex = transcript.findLastIndex((message) => message.role === "user");
    if (transcript[userIndex]?.text !== LOOP_INPUT) return "ok";
    const step = transcript.slice(userIndex).filter((message) => message.role === "toolResult").length;
    return step < LOOP_STEPS ? { toolCall: { name: "no_such_tool", arguments: { step } } } : "ok";
}

type Fixture = {
    /** The catalogue both listeners call. */
    catalogue: Catalogue;
    invoke(name: string, input: unknown): Promise<unknown>;
    openFeed(listener: Listener, query: string, headers?: OutgoingHttpHeaders): Promise<FeedStream>;
    post(listener: Listener, name: string, input: unknown, headers?: OutgoingHttpHeaders): Promise<Answer>;
    /** Starts a job in-process and waits until its lead conversation is idle. */
    idleConversation(jobId: string): Promise<string>;
    /** Submits input in-process and waits until it is done and the conversation idle again. */
    submitAndSettle(conversationId: string, content: string): Promise<void>;
    entries(conversationId: string): Promise<Entry[]>;
};

async function startFixture(
    reply: (transcript: FakeTranscript) => FakeReply = () => "ok",
    modelOptions: FakeModelOptions = {},
): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(reply, modelOptions);
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    await writeFile(join(env.configDir, "config.toml"), `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
    const agents = await createAgentsComponent({ logger: quietLogger });
    const network = createNetworkListenerComponent({ freePort: true });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, networkSection],
        components: [agents.component, createLocalSocketComponent(), network],
        operations: agents.operations,
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation, "the fake model's api is registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    daemons.push(daemon);
    await until(async () => daemon.phase() === "ready", "the daemon to be ready");
    const socketPath = localSocketPath(env.runtimeDir);

    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, IN_PROCESS);

    function targetOf(listener: Listener): HttpTarget {
        if (listener === "local socket") return { socketPath };
        const address = network.address();
        assert.ok(address, "the network listener is running");
        return address;
    }

    async function openFeed(listener: Listener, query: string, headers: OutgoingHttpHeaders = {}) {
        const stream = await openFeedAt(targetOf(listener), query, headers);
        streams.push(stream);
        return stream;
    }

    async function submitAndSettle(conversationId: string, content: string): Promise<void> {
        const submit = { conversationId, content, requestId: `${conversationId}-${content}` };
        const { submissionId } = (await invoke("conversations.submit", submit)) as { submissionId: string };
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_WAIT_MS })) as {
            state: string;
        };
        assert.equal(waited.state, "done", `submission ${submissionId} is done`);
        const isIdle = async () =>
            ((await invoke("conversations.get", { conversationId })) as { status: string }).status === "idle";
        await until(isIdle, `conversation ${conversationId} to be idle`);
    }

    async function idleConversation(jobId: string): Promise<string> {
        const { conversationId } = (await invoke("jobs.startLead", { jobId, firstInput: "hello" })) as {
            conversationId: string;
        };
        await submitAndSettle(conversationId, `settle-${jobId}`);
        return conversationId;
    }

    async function entries(conversationId: string): Promise<Entry[]> {
        const all: Entry[] = [];
        let after: string | undefined;
        do {
            const input = { conversationId, limit: ENTRIES_PAGE_LIMIT, ...(after !== undefined && { after }) };
            const page = (await invoke("conversations.entries", input)) as { entries: Entry[]; next?: string };
            all.push(...page.entries);
            after = page.next;
        } while (after !== undefined);
        return all;
    }

    const postTo = (listener: Listener, name: string, input: unknown, headers: OutgoingHttpHeaders = {}) =>
        post(targetOf(listener), name, input, headers);

    const fixture = { catalogue: daemon.catalogue, invoke, openFeed, post: postTo, idleConversation, submitAndSettle };
    return { ...fixture, entries };
}

async function nextEvent(stream: FeedStream): Promise<FeedEvent> {
    const read = await stream.next();
    assert.ok(typeof read === "object", `the stream gives a next event, not ${read}`);
    return read;
}

/** Reads `delta` events until one shows the conversation idle with `content` in its entries. */
async function readDeltasUntilSettled(stream: FeedStream, content: string): Promise<FeedEvent[]> {
    const deltas: FeedEvent[] = [];
    for (;;) {
        const event = await nextEvent(stream);
        assert.equal(event.name, "delta", `event ${JSON.stringify(event).slice(0, 200)} is a delta`);
        deltas.push(event);
        const view = (event.data as { view: View }).view;
        if (!view.busy && JSON.stringify(view.entries).includes(content)) return deltas;
    }
}

/** Asserts the deltas carry ids 1, 2, 3 … equal to their sequence numbers, each extending the view before it. */
function assertCommitOrder(snapshot: View, deltas: readonly FeedEvent[]): void {
    assert.deepEqual(
        deltas.map((delta) => delta.id),
        deltas.map((_, index) => index + 1),
    );
    let previousLength = snapshot.entries.length;
    for (const delta of deltas) {
        const { seq, view } = delta.data as { seq: number; view: View };
        assert.equal(seq, delta.id, "the event id is the delta's sequence number");
        assert.ok(view.entries.length >= previousLength, "each delta extends the view before it");
        previousLength = view.entries.length;
    }
}

/** Opens the conversation feed, lets a run commit `content`, and returns the snapshot and the deltas read. */
async function observeRun(fixture: Fixture, listener: Listener, conversationId: string, content: string) {
    const stream = await fixture.openFeed(listener, `?scope=conversation&id=${conversationId}`);
    assert.equal(stream.status, 200);
    const first = await nextEvent(stream);
    assert.equal(first.name, "snapshot");
    await fixture.submitAndSettle(conversationId, content);
    const deltas = await readDeltasUntilSettled(stream, content);
    stream.close();
    return { snapshot: first.data as View, deltas };
}

describe("the conversation feed through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`starts each stream over the ${listener} with a fresh snapshot, then deltas in commit order`, async () => {
            const fixture = await startFixture();
            const conversationId = await fixture.idleConversation("observed");

            const first = await observeRun(fixture, listener, conversationId, "first run");
            const second = await observeRun(fixture, listener, conversationId, "second run");

            assertCommitOrder(first.snapshot, first.deltas);
            assertCommitOrder(second.snapshot, second.deltas);
            assert.ok(!JSON.stringify(first.snapshot).includes("first run"), "the first snapshot precedes its run");
            assert.ok(JSON.stringify(second.snapshot).includes("first run"), "the second snapshot is fresh");
            const replayed = second.deltas.filter((delta) => !JSON.stringify(delta.data).includes("first run"));
            assert.deepEqual(replayed, [], "the second stream replays no delta from before its snapshot");
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
        assert.deepEqual(byJob, { alpha: { id: alpha, isLead: true }, beta: { id: beta, isLead: true } });
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

/** Reads the rest of a stream; returns its last event and whether the server ended it or it fell silent. */
async function readToEnd(stream: FeedStream): Promise<{ last?: FeedEvent; how: "ended" | "silent" }> {
    let last: FeedEvent | undefined;
    for (;;) {
        const read = await stream.next();
        if (typeof read !== "object") return { last, how: read };
        last = read;
    }
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
        const delayMs = (transcript: FakeTranscript) =>
            transcript.findLast((message) => message.role === "user")?.text === HOLD_INPUT ? HOLD_DELAY_MS : 0;
        const fixture = await startFixture(() => "ok", { delayMs });
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

type Subscription = { next(): Promise<unknown>; close(): void };

/** Records what each subscription `feed.subscribe` hands a listener last read: a delta or the reason it closed. */
function recordSubscriptionReads(catalogue: Catalogue): unknown[][] {
    const readsBySubscription: unknown[][] = [];
    const invoke = catalogue.invoke.bind(catalogue);
    mock.method(catalogue, "invoke", async (name: string, input: unknown, caller: Caller) => {
        const result = await invoke(name, input, caller);
        if (name !== "feed.subscribe") return result;
        const subscription = result as Subscription;
        const reads: unknown[] = [];
        readsBySubscription.push(reads);
        const next = subscription.next;
        subscription.next = async () => {
            const read = await next();
            reads.push(read);
            return read;
        };
        return subscription;
    });
    return readsBySubscription;
}

/** Polls `read` until it equals `expected` or the wait ends, then asserts it does. */
async function eventuallyEqual(read: () => Promise<unknown>, expected: unknown, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let actual = await read();
    while (!isDeepStrictEqual(actual, expected) && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        actual = await read();
    }
    assert.deepEqual(actual, expected, what);
}

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
