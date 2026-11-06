/**
 * One feed stream for several conversations through both listeners of a real daemon (S-003 REQ-006, REQ-010,
 * REQ-011): `GET /feed?scope=conversations` sends a snapshot per named conversation and then their deltas, each event
 * naming its conversation, ends the others when one subscription ends, and ends `unsubscribed` when the client
 * leaves.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { type IncomingMessage, type OutgoingHttpHeaders, request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
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
import { createFakeModel, type FakeReply, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const SETTLE_WAIT_MS = 30_000;
const EVENT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 90_000;
const LOOPBACK = "127.0.0.1";
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
/** `jobs.create` refuses the in-process way in, so the leads are created as a team member at the command line. */
const COMMAND_LINE: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const quietLogger = createLogger({ stream: { write: () => true } });
const LISTENERS = ["local socket", "network listener"] as const;
/** About three commits per step, so a run of this many steps produces well over the 1000 deltas of the bound. */
const LOOP_STEPS = 450;
const LOOP_INPUT = "loop";
const LAGGING_END: FeedEvent = { name: "end", data: { reason: "lagging" } };
const STOPPED_END: FeedEvent = { name: "end", data: { reason: "stopped" } };

type Listener = (typeof LISTENERS)[number];
type HttpTarget = { socketPath: string } | { host: string; port: number };
type View = { busy: boolean };
type FeedEvent = { name: string; id?: number; data: unknown };
type Wrapped = { conversationId: string; event: { seq?: number; view?: View } };
type AnswerBody = { error?: { code: string; message?: string } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];
const streams: FeedStream[] = [];

afterEach(async () => {
    mock.restoreAll();
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
    daemon: RunningDaemon;
    invoke(name: string, input: unknown): Promise<unknown>;
    openFeed(listener: Listener, query: string): Promise<FeedStream>;
    /** Creates a job as a team member at the command line and waits until its lead conversation is idle. */
    idleConversation(label: string): Promise<string>;
    /** Submits input in-process and waits until it is done and the conversation idle again. */
    submitAndSettle(conversationId: string, content: string): Promise<void>;
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

    async function openFeed(listener: Listener, query: string) {
        const stream = await openFeedAt(targetOf(listener), query, {});
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

    async function idleConversation(label: string): Promise<string> {
        const created = (await daemon.catalogue.invoke("jobs.create", { text: `hello ${label}` }, COMMAND_LINE)) as {
            leadConversation: string;
        };
        await submitAndSettle(created.leadConversation, `settle-${label}`);
        return created.leadConversation;
    }

    return { daemon, invoke, openFeed, idleConversation, submitAndSettle };
}

async function nextEvent(stream: FeedStream): Promise<FeedEvent> {
    const read = await stream.next();
    assert.ok(typeof read === "object", `the stream gives a next event, not ${read}`);
    return read;
}

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

/** Reads the rest of a stream; returns its last event and whether the server ended it or it fell silent. */
async function readToEnd(stream: FeedStream): Promise<{ last?: FeedEvent; how: "ended" | "silent" }> {
    let last: FeedEvent | undefined;
    for (;;) {
        const read = await stream.next();
        if (typeof read !== "object") return { last, how: read };
        last = read;
    }
}

type Subscription = { next(): Promise<unknown>; close(): void };

/** Records what each subscription `feed.subscribe` hands a listener: each delta read, then the reason it closed. */
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
        // A closed subscription is not read again once the stream has ended, so its reason is recorded when it closes.
        (subscription as unknown as { closed: Promise<unknown> }).closed.then((reason) =>
            reads.push({ closed: reason }),
        );
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
async function eventuallyEqual(read: () => unknown, expected: unknown, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!isDeepStrictEqual(read(), expected) && Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
    assert.deepEqual(read(), expected, what);
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
        const reads = recordSubscriptionReads(fixture.daemon.catalogue);

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
        const reads = recordSubscriptionReads(fixture.daemon.catalogue);

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
        const reads = recordSubscriptionReads(fixture.daemon.catalogue);

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

        await fixture.daemon.stop();

        assert.deepEqual(await Promise.all(open.map(readToEnd)), [
            { last: STOPPED_END, how: "ended" },
            { last: STOPPED_END, how: "ended" },
        ]);
    });
});
