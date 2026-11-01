/**
 * The feed and long calls through both listeners of a real daemon (S-003 REQ-006, REQ-011, REQ-012): `GET /feed`
 * streams a snapshot and then deltas over Server-Sent Events, a client that stops reading is ended `lagging` without
 * touching the run, and neither a quiet stream nor a long `submissions.wait` is cut short by the listener.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createFakeModel, type FakeReply, type FakeTranscript } from "../support/fake_model.ts";
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

type Listener = (typeof LISTENERS)[number];
type HttpTarget = { socketPath: string } | { host: string; port: number };
type Entry = { kind: string; data: unknown };
type View = { entries: Entry[]; busy: boolean };
type FeedEvent = { name: string; id?: number; data: unknown };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];
const streams: FeedStream[] = [];

afterEach(async () => {
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
    refusal(): Promise<{ error?: { code: string } }>;
    next(): Promise<FeedRead>;
    pause(): void;
    resume(): void;
    close(): void;
};

function openFeedAt(target: HttpTarget, query: string): Promise<FeedStream> {
    return new Promise((resolve, reject) => {
        const call = request({ ...target, method: "GET", path: `/feed${query}`, agent: false }, (response) => {
            resolve(readFeed(response, () => call.destroy()));
        });
        call.once("error", reject);
        call.end();
    });
}

function readJson(response: IncomingMessage): Promise<{ error?: { code: string } }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        response.once("error", reject);
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
    invoke(name: string, input: unknown): Promise<unknown>;
    openFeed(listener: Listener, query: string): Promise<FeedStream>;
    /** Starts a job in-process and waits until its lead conversation is idle. */
    idleConversation(jobId: string): Promise<string>;
    /** Submits input in-process and waits until it is done and the conversation idle again. */
    submitAndSettle(conversationId: string, content: string): Promise<void>;
    entries(conversationId: string): Promise<Entry[]>;
};

async function startFixture(reply: (transcript: FakeTranscript) => FakeReply = () => "ok"): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(reply);
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

    async function openFeed(listener: Listener, query: string): Promise<FeedStream> {
        const stream = await openFeedAt(targetOf(listener), query);
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

    return { invoke, openFeed, idleConversation, submitAndSettle, entries };
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
        const conversations = (snapshots[0]?.data as InstanceSnapshot).conversations;
        const byJob = Object.fromEntries(conversations.map(({ id, jobId, isLead }) => [jobId, { id, isLead }]));
        assert.deepEqual(byJob, { alpha: { id: alpha, isLead: true }, beta: { id: beta, isLead: true } });
        assert.ok(conversations.every(({ seat, status }) => seat?.role === "bob" && status === "idle"));
        assert.equal((snapshots[0]?.data as InstanceSnapshot).workerThreads.inUse, 0);
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
