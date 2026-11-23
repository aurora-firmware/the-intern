/**
 * What the listener feed tests share (S-003 REQ-006, REQ-011): a real daemon behind both listeners, a client that
 * reads Server-Sent Events from `GET /feed` event by event, and the helpers that read and wait on them. A test file
 * calls `disposeFixtures` after each test.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { type IncomingMessage, type OutgoingHttpHeaders, request } from "node:http";
import { join } from "node:path";
import { mock } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller, Catalogue } from "../../src/service/operations.ts";
import { createFakeModel, type FakeModelOptions, type FakeReply, type FakeTranscript } from "./fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";
import { waitForJobStatus } from "./job_status.ts";
import { scaled } from "./time_scale.ts";

export const WAIT_TIMEOUT_MS = scaled(20_000);
export const POLL_INTERVAL_MS = 10;
export const SETTLE_WAIT_MS = scaled(30_000);
export const EVENT_TIMEOUT_MS = scaled(10_000);
/** How long the loop may run again before a client that stops reading must have been ended. */
export const STALL_DEADLINE_MS = scaled(60_000);

export const ENTRIES_PAGE_LIMIT = 500;
export const LOOPBACK = "127.0.0.1";
export const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
/** `jobs.create` refuses the in-process way in, so the leads are created as a team member at the command line. */
export const COMMAND_LINE: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
export const quietLogger = createLogger({ stream: { write: () => true } });
export const LISTENERS = ["local socket", "network listener"] as const;
/** About three commits per step, so a run of this many steps produces more deltas than the 1000 of the bound. */
export const LOOP_STEPS = 450;
export const LOOP_INPUT = "loop";

export const LAGGING_END: FeedEvent = { name: "end", data: { reason: "lagging" } };

export const JSON_HEADERS: OutgoingHttpHeaders = { "content-type": "application/json" };

export type Listener = (typeof LISTENERS)[number];
export type HttpTarget = { socketPath: string } | { host: string; port: number };
export type Entry = { kind: string; data: unknown };
export type View = { entries: Entry[]; busy: boolean };
export type FeedEvent = { name: string; id?: number; data: unknown };
export type AnswerBody = { result?: unknown; error?: { code: string; message?: string } };
export type Answer = { status: number; body: AnswerBody };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];
const streams: FeedStream[] = [];

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

/** Parses one Server-Sent Event block: `event:`, an optional `id:` and one `data:` line holding JSON. */
export function parseEvent(block: string): FeedEvent {
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
export type FeedRead = FeedEvent | "ended" | "silent";

/** A `GET /feed` stream read event by event. */
export type FeedStream = {
    status: number;
    /** The JSON body of a refused subscription. */
    refusal(): Promise<AnswerBody>;
    next(): Promise<FeedRead>;
    /** How many events have arrived and not been taken by `next` yet. */
    unread(): number;
    pause(): void;
    resume(): void;
    close(): void;
};

export function openFeedAt(target: HttpTarget, query: string, headers: OutgoingHttpHeaders): Promise<FeedStream> {
    return new Promise((resolve, reject) => {
        const options = { ...target, method: "GET", path: `/feed${query}`, headers, agent: false };
        const call = request(options, (response) => {
            resolve(readFeed(response, () => call.destroy()));
        });
        call.once("error", reject);
        call.end();
    });
}

export function readJson(response: IncomingMessage): Promise<AnswerBody> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        response.once("error", reject);
    });
}

/** Calls an operation; a connection the listener cuts is answered with status 0 and the connection error. */
export function post(target: HttpTarget, name: string, input: unknown, headers: OutgoingHttpHeaders): Promise<Answer> {
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

export function readFeed(response: IncomingMessage, destroy: () => void): FeedStream {
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
        unread: () => events.length,
        pause: () => response.pause(),
        resume: () => response.resume(),
        close: destroy,
    };
}

/** Where a model request stands in a run of `LOOP_INPUT`: the run's number in the conversation and the steps taken. */
export type LoopProgress = { run: number; step: number };

/**
 * Answers `LOOP_INPUT` with calls to a tool that does not exist, each answered by an error result, and then with
 * text; any other input is answered with text at once. `stepsOf` says how many calls run number `run` makes, and is
 * asked at every request, with the steps taken so far. Each call carries `padBytes` of text, so a delta can be made
 * large.
 */
export function loopingReplyOf(
    stepsOf: (progress: LoopProgress) => number,
    padBytes = 0,
): (transcript: FakeTranscript) => FakeReply {
    return (transcript) => {
        const userIndex = transcript.findLastIndex((message) => message.role === "user");
        if (transcript[userIndex]?.text !== LOOP_INPUT) return "ok";
        const run = transcript.filter((message) => message.role === "user" && message.text === LOOP_INPUT).length;
        const step = transcript.slice(userIndex).filter((message) => message.role === "toolResult").length;
        if (step >= stepsOf({ run, step })) return "ok";
        const pad = padBytes > 0 ? { pad: "x".repeat(padBytes) } : {};
        return { toolCall: { name: "no_such_tool", arguments: { step, ...pad } } };
    };
}

/** `LOOP_STEPS` calls in every run. */
export const loopingReply = loopingReplyOf(() => LOOP_STEPS);

export type Fixture = {
    /** Stops the daemon. */
    stop(): Promise<void>;
    /** The catalogue both listeners call. */
    catalogue: Catalogue;
    invoke(name: string, input: unknown): Promise<unknown>;
    openFeed(listener: Listener, query: string, headers?: OutgoingHttpHeaders): Promise<FeedStream>;
    post(listener: Listener, name: string, input: unknown, headers?: OutgoingHttpHeaders): Promise<Answer>;
    /** Creates a job as a team member at the command line and waits until its lead conversation is idle. */
    idleConversation(label: string): Promise<string>;
    /** The ID of the job whose lead is the conversation `idleConversation` returned. */
    jobIdOf(conversationId: string): string;
    /** Submits input in-process and waits until it is done and the conversation idle again. */
    submitAndSettle(conversationId: string, content: string, requestId?: string): Promise<void>;
    entries(conversationId: string): Promise<Entry[]>;
};

export async function startFixture(
    reply: (transcript: FakeTranscript) => FakeReply = () => "ok",
    modelOptions: FakeModelOptions = {},
    piSettings: Record<string, unknown> = {},
): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(reply, modelOptions);
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id, ...piSettings }),
    );
    await writeFile(join(env.configDir, "config.toml"), `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const network = createNetworkListenerComponent({ freePort: true });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, networkSection],
        components: [agents.component, jobs.component, createLocalSocketComponent(), network],
        operations: [...agents.operations, ...jobs.operations],
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

    async function submitAndSettle(
        conversationId: string,
        content: string,
        requestId = `${conversationId}-${content}`,
    ): Promise<void> {
        const submit = { conversationId, content, requestId };
        const { submissionId } = (await invoke("conversations.submit", submit)) as { submissionId: string };
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_WAIT_MS })) as {
            state: string;
        };
        assert.equal(waited.state, "done", `submission ${submissionId} is done`);
        const isIdle = async () =>
            ((await invoke("conversations.get", { conversationId })) as { status: string }).status === "idle";
        await until(isIdle, `conversation ${conversationId} to be idle`);
    }

    const jobIds = new Map<string, string>();

    async function idleConversation(label: string): Promise<string> {
        const created = (await daemon.catalogue.invoke("jobs.create", { text: `hello ${label}` }, COMMAND_LINE)) as {
            id: string;
            leadConversation: string;
        };
        const conversationId = created.leadConversation;
        jobIds.set(conversationId, created.id);
        await waitForJobStatus(
            async () => ((await invoke("jobs.get", { job: created.id })) as { status: string }).status,
            "in_progress",
        );
        await submitAndSettle(conversationId, `settle-${label}`);
        return conversationId;
    }

    function jobIdOf(conversationId: string): string {
        const jobId = jobIds.get(conversationId);
        assert.ok(jobId, `conversation ${conversationId} is the lead of a created job`);
        return jobId;
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

    return {
        stop: async () => {
            await daemon.stop();
        },
        catalogue: daemon.catalogue,
        invoke,
        openFeed,
        post: postTo,
        idleConversation,
        jobIdOf,
        submitAndSettle,
        entries,
    };
}

export async function nextEvent(stream: FeedStream): Promise<FeedEvent> {
    const read = await stream.next();
    assert.ok(typeof read === "object", `the stream gives a next event, not ${read}`);
    return read;
}

/** Reads the rest of a stream; returns its last event and whether the server ended it or it fell silent. */
export async function readToEnd(stream: FeedStream): Promise<{ last?: FeedEvent; how: "ended" | "silent" }> {
    let last: FeedEvent | undefined;
    for (;;) {
        const read = await stream.next();
        if (typeof read !== "object") return { last, how: read };
        last = read;
    }
}

export type Subscription = { next(): Promise<unknown>; close(): void };

/**
 * Records what each subscription `feed.subscribe` hands a listener: each delta read, then the reason it closed.
 * `onClosed` is told the index of each subscription that closes, once its reason is recorded.
 */
export function recordSubscriptionReads(
    catalogue: Catalogue,
    onClosed: (subscription: number) => void = () => {},
): unknown[][] {
    const readsBySubscription: unknown[][] = [];
    const invoke = catalogue.invoke.bind(catalogue);
    mock.method(catalogue, "invoke", async (name: string, input: unknown, caller: Caller) => {
        const result = await invoke(name, input, caller);
        if (name !== "feed.subscribe") return result;
        const subscription = result as Subscription;
        const reads: unknown[] = [];
        const index = readsBySubscription.push(reads) - 1;
        // A subscription closed after the stream ended is not read again, so its reason is recorded when it closes.
        void (subscription as unknown as { closed: Promise<unknown> }).closed.then((reason) => {
            reads.push({ closed: reason });
            onClosed(index);
        });
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

/** Feed streams that stopped reading after their snapshots, and the reads of the subscriptions behind them. */
export type StalledFeeds = { streams: FeedStream[]; reads: unknown[][]; resume(): void };

/**
 * Opens the feed `query` over each listener, one after another, reads its `snapshots` snapshots and stops reading. A
 * stream is read again as soon as a subscription behind it closes: its connection is still full, and the listener
 * closes a connection that cannot take the stream's `end` event within a second. With `isHeld`, no stream is read
 * again until the test calls `resume`, so it can look at the run first; then the stream of each listener should be
 * opened alone, since the streams close in different runs and one that closes long before `resume` is cut off.
 * `listeners` are the listeners to open the feed over, both by default.
 */
export async function openStalledFeeds(
    fixture: Fixture,
    query: string,
    snapshots: number,
    { isHeld = false, listeners = LISTENERS }: { isHeld?: boolean; listeners?: readonly Listener[] } = {},
): Promise<StalledFeeds> {
    const streams: FeedStream[] = [];
    const streamOfSubscription: number[] = [];
    const reads = recordSubscriptionReads(fixture.catalogue, (subscription) => {
        if (!isHeld) streams[streamOfSubscription[subscription] as number]?.resume();
    });
    for (const listener of listeners) {
        const firstSubscription = reads.length;
        const stream = await fixture.openFeed(listener, query);
        for (let subscription = firstSubscription; subscription < reads.length; subscription++) {
            streamOfSubscription[subscription] = streams.length;
        }
        for (let event = 0; event < snapshots; event++) assert.equal((await nextEvent(stream)).name, "snapshot");
        stream.pause();
        streams.push(stream);
    }
    return {
        streams,
        reads,
        resume: () => {
            for (const stream of streams) stream.resume();
        },
    };
}

const isClosedRead = (read: unknown): boolean => typeof read === "object" && read !== null && "closed" in read;

/** Whether `subscriptions` subscriptions are recorded and each has closed. */
export function haveClosed(reads: readonly unknown[][], subscriptions: number): boolean {
    return reads.length === subscriptions && reads.every((read) => isClosedRead(read.at(-1)));
}

/** Runs `LOOP_INPUT` once more in the conversation, as its loop run number `loop` (a request ID is used once). */
async function runLoop(fixture: Fixture, conversationId: string, loop: number): Promise<void> {
    await fixture.submitAndSettle(conversationId, LOOP_INPUT, `${conversationId}-${LOOP_INPUT}-${loop}`);
}

/** Runs `LOOP_INPUT` in the conversation `count` times, one after another. */
export async function runLoops(fixture: Fixture, conversationId: string, count: number): Promise<void> {
    for (let loop = 1; loop <= count; loop++) await runLoop(fixture, conversationId, loop);
}

/**
 * Runs `LOOP_INPUT` in the conversation until each of the `subscriptions` recorded subscriptions in `reads` has
 * closed, and returns how many runs that took. The conversation made `runsBefore` loop runs already. The deltas a
 * client that stops reading leaves behind wait in its subscription only once its connection holds no more, and how
 * much a connection holds depends on the system, so the runs go on until the bound has closed the stream. Fails when
 * a subscription is still open at the deadline.
 */
export async function loopUntilClosed(
    fixture: Fixture,
    conversationId: string,
    {
        reads,
        subscriptions,
        runsBefore = 0,
    }: { reads: readonly unknown[][]; subscriptions: number; runsBefore?: number },
): Promise<number> {
    const deadline = Date.now() + STALL_DEADLINE_MS;
    let runs = 0;
    while (!haveClosed(reads, subscriptions)) {
        assert.ok(Date.now() < deadline, `a subscription is still open after ${runs} runs of the loop`);
        await runLoop(fixture, conversationId, runsBefore + ++runs);
    }
    return runs;
}

/** Polls `read` until it equals `expected` or the wait ends, then asserts it does. */
export async function eventuallyEqual(read: () => unknown, expected: unknown, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let actual = await read();
    while (!isDeepStrictEqual(actual, expected) && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        actual = await read();
    }
    assert.deepEqual(actual, expected, what);
}

/** Closes the open streams, stops the daemons and releases the fake models and environments the fixtures made. */
export async function disposeFixtures(): Promise<void> {
    for (const stream of streams.splice(0)) stream.close();
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
}
