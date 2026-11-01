/**
 * The catalogue through both listeners of a real daemon (S-003 REQ-003, REQ-004, REQ-005, REQ-014): every operation
 * answers over the local socket and the network listener as it answers in-process.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { type IncomingHttpHeaders, type OutgoingHttpHeaders, request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type AgentsComponent, createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Storage } from "../../src/host/harness_host.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import { type Caller, ServiceError, type ServiceErrorCode } from "../../src/service/operations.ts";
import { createFakeModel, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { createTestOperations, type StorageSwitch } from "../support/test_operations.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const HOLD_DELAY_MS = 60_000;
const SETTLE_WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const LOOPBACK = "127.0.0.1";
/** Input starting with this word holds the fake model's answer until the run is aborted. */
const HOLD_WORD = "hold";
const OWNER_ONLY_MODE = 0o700;
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
const quietLogger = createLogger({ stream: { write: () => true } });

/** The HTTP status S-003's Interfaces table gives each code, written out so a changed mapping is caught. */
const STATUS_OF: Record<ServiceErrorCode, number> = {
    invalid_input: 400,
    not_found: 404,
    busy: 409,
    conflict: 409,
    unavailable: 503,
    internal: 500,
};
/** Values that differ between calls by nature: the keys holding ids, times, and the recorded way in. */
const ID_KEYS = new Set(["id", "conversationId", "submissionId"]);
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const WAY_IN = /"(in-process|command line|web interface)"/g;
/** Served as a stream, so it has no operation route (S-003 REQ-006). */
const STREAM_OPERATION = "feed.subscribe";
/** The test operations are not product operations; `test.failStorage` would break storage for the rest of the run. */
const TEST_OPERATION_PREFIX = "test.";

type Way = "in-process" | "local socket" | "network listener";
const WAYS: readonly Way[] = ["in-process", "local socket", "network listener"];
type HttpTarget = { socketPath: string } | { host: string; port: number };
type Answer = { status: number; headers: IncomingHttpHeaders; body: unknown };
type Outcome = { status: number; body: unknown };
type Built = { input: unknown; names?: string[] };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

function lastUserText(transcript: FakeTranscript): string {
    return transcript.findLast((turn) => turn.role === "user")?.text ?? "";
}

function failingOnDemand(storage: Storage, storageSwitch: StorageSwitch): Storage {
    return new Proxy(storage, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property === "commit" && storageSwitch.isFailing) {
                return () => Promise.reject(new Error("storage commit refused"));
            }
            return value.bind(target);
        },
    });
}

function send(target: HttpTarget, method: string, path: string, headers: OutgoingHttpHeaders, body?: string) {
    return new Promise<Answer>((resolve, reject) => {
        const call = request({ ...target, method, path, headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(text) });
            });
            response.once("error", reject);
        });
        call.once("error", reject);
        call.end(body);
    });
}

/** Replaces the values that differ by nature, and the names a builder made for one way only. */
function comparable(value: unknown, names: readonly string[] = []): unknown {
    let text = JSON.stringify(value, (key, field) => (ID_KEYS.has(key) && typeof field === "string" ? "<id>" : field));
    for (const name of [...names].sort((a, b) => b.length - a.length)) text = text.split(name).join("<name>");
    return JSON.parse(text.replace(ISO_TIME, "<time>").replace(WAY_IN, '"<way in>"'));
}

type Fixture = {
    env: HermeticEnv;
    daemon: RunningDaemon;
    ctx: ServiceContext;
    agents: AgentsComponent;
    storageSwitch: StorageSwitch;
    targetOf(way: Exclude<Way, "in-process">): HttpTarget;
    invoke(name: string, input: unknown): Promise<unknown>;
    call(way: Way, name: string, input: unknown, headers?: OutgoingHttpHeaders): Promise<Outcome>;
    folder(name: string): Promise<string>;
    settledConversation(jobId: string): Promise<string>;
    runningConversation(jobId: string): Promise<string>;
    stateSnapshot(): Promise<unknown>;
};

type FixtureOptions = { lastComponents?: readonly DaemonComponent[] };

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", {
        delayMs: (transcript) => (lastUserText(transcript).startsWith(HOLD_WORD) ? HOLD_DELAY_MS : 0),
    });
    fakes.push(fake);
    const provider = fake.getModel().provider;
    const modelId = `${provider}/${fake.getModel().id}`;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    await writeFile(join(env.configDir, "config.toml"), `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
    const agents = await createAgentsComponent({ logger: quietLogger });
    const storageSwitch: StorageSwitch = { isFailing: false };
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        async start(ctx) {
            captured = ctx;
        },
    };
    const network = createNetworkListenerComponent({ freePort: true });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, networkSection],
        components: [agents.component, probe, createLocalSocketComponent(), network, ...(options.lastComponents ?? [])],
        operations: [...agents.operations, ...createTestOperations({ storageSwitch, modelFor: () => modelId })],
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
        openStorage: async (file) => failingOnDemand(await openNodeSqliteStorage(file), storageSwitch),
    });
    daemons.push(daemon);
    await until(() => daemon.phase() === "ready", "the daemon to be ready");
    assert.ok(captured, "the probe component has started");
    const ctx = captured;
    const socketPath = localSocketPath(env.runtimeDir);

    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, IN_PROCESS);

    function targetOf(way: Exclude<Way, "in-process">): HttpTarget {
        if (way === "local socket") return { socketPath };
        const address = network.address();
        assert.ok(address, "the network listener is running");
        return address;
    }

    async function callInProcess(name: string, input: unknown): Promise<Outcome> {
        try {
            const result = await invoke(name, input);
            return { status: 200, body: { result: JSON.parse(JSON.stringify(result)) } };
        } catch (error) {
            if (!(error instanceof ServiceError)) throw error;
            return { status: STATUS_OF[error.code], body: { error: { code: error.code, message: error.message } } };
        }
    }

    async function call(way: Way, name: string, input: unknown, headers: OutgoingHttpHeaders = {}) {
        if (way === "in-process") return callInProcess(name, input);
        const allHeaders = { "content-type": "application/json", ...headers };
        const { status, body } = await send(
            targetOf(way),
            "POST",
            `/operations/${name}`,
            allHeaders,
            JSON.stringify(input),
        );
        return { status, body };
    }

    async function statusOf(conversationId: string): Promise<string> {
        return ((await invoke("conversations.get", { conversationId })) as { status: string }).status;
    }

    async function settledConversation(jobId: string): Promise<string> {
        const { conversationId } = (await invoke("jobs.startLead", { jobId, firstInput: "hello" })) as {
            conversationId: string;
        };
        const settle = { conversationId, content: "settle", requestId: `settle-${jobId}` };
        const { submissionId } = (await invoke("conversations.submit", settle)) as { submissionId: string };
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_WAIT_MS })) as {
            state: string;
        };
        assert.equal(waited.state, "done", `the settle input of ${jobId} is done`);
        await until(async () => (await statusOf(conversationId)) === "idle", `${jobId} to be idle`);
        return conversationId;
    }

    async function runningConversation(jobId: string): Promise<string> {
        const { conversationId } = (await invoke("jobs.startLead", { jobId, firstInput: HOLD_WORD })) as {
            conversationId: string;
        };
        await until(async () => (await statusOf(conversationId)) === "running", `${jobId} to be running`);
        return conversationId;
    }

    async function folder(name: string): Promise<string> {
        const path = join(env.root, name);
        await mkdir(path, { mode: OWNER_ONLY_MODE });
        await chmod(path, OWNER_ONLY_MODE);
        return path;
    }

    /** Every conversation with all its entries, and the configuration file: what a read must not change. */
    async function stateSnapshot(): Promise<unknown> {
        const conversations = [];
        for (const info of await ctx.host.listConversations()) {
            const entries = [];
            let after: string | undefined;
            do {
                const page = await ctx.host.readEntries(
                    info.id,
                    after === undefined ? { limit: 500 } : { after, limit: 500 },
                );
                entries.push(...page.entries);
                after = page.next;
            } while (after !== undefined);
            conversations.push({ info, entries });
        }
        return { conversations, config: await readFile(join(env.configDir, "config.toml"), "utf8") };
    }

    return {
        env,
        daemon,
        ctx,
        agents,
        storageSwitch,
        targetOf,
        invoke,
        call,
        folder,
        settledConversation,
        runningConversation,
        stateSnapshot,
    };
}

type Seed = { conversationId: string; submissionId: string };
type InputBuilder = (fixture: Fixture, seed: Seed, way: Way) => Promise<Built>;

const label = (way: Way) => way.replace(" ", "-");

/** A valid input for each operation called; a control operation builds a fresh, equal target for each way. */
const INPUT_BUILDERS: Record<string, InputBuilder> = {
    "daemon.status": async () => ({ input: {} }),
    "conversations.list": async () => ({ input: {} }),
    "conversations.get": async (_f, seed) => ({ input: { conversationId: seed.conversationId } }),
    "conversations.invocations": async (_f, seed) => ({ input: { conversationId: seed.conversationId } }),
    "conversations.entries": async (_f, seed) => ({ input: { conversationId: seed.conversationId, limit: 50 } }),
    "conversations.context": async (_f, seed) => ({ input: { conversationId: seed.conversationId } }),
    "submissions.get": async (_f, seed) => ({ input: { submissionId: seed.submissionId } }),
    "submissions.wait": async (_f, seed) => ({ input: { submissionId: seed.submissionId, timeoutMs: 0 } }),
    "usage.get": async (_f, seed) => ({ input: { conversationId: seed.conversationId } }),
    "tasks.live": async (_f, seed) => ({ input: { conversationId: seed.conversationId } }),
    "models.list": async () => ({ input: {} }),
    "roles.list": async () => ({ input: {} }),
    "workspaces.list": async () => ({ input: {} }),
    "conversations.submit": async (fixture, _seed, way) => {
        const conversationId = await fixture.settledConversation(`submit-${label(way)}`);
        return { input: { conversationId, content: "more", requestId: "more" } };
    },
    "conversations.abort": async (fixture, _seed, way) => ({
        input: { conversationId: await fixture.settledConversation(`abort-${label(way)}`) },
    }),
    "conversations.reset": async (fixture, _seed, way) => ({
        input: { conversationId: await fixture.settledConversation(`reset-${label(way)}`), note: "fresh start" },
    }),
    "conversations.compact": async (fixture, _seed, way) => ({
        input: { conversationId: await fixture.settledConversation(`compact-${label(way)}`) },
    }),
    "conversations.seat": async (fixture, _seed, way) => ({
        input: { conversationId: await fixture.settledConversation(`seat-${label(way)}`), role: "gp" },
    }),
    "jobs.startLead": async (_f, _seed, way) => ({
        input: { jobId: `job-${label(way)}`, firstInput: "start" },
        names: [`job-${label(way)}`],
    }),
    "submissions.withdraw": async (fixture, _seed, way) => {
        const conversationId = await fixture.runningConversation(`withdraw-${label(way)}`);
        const queued = { conversationId, content: "queued", requestId: "queued" };
        const { submissionId } = (await fixture.invoke("conversations.submit", queued)) as { submissionId: string };
        return { input: { submissionId } };
    },
    "roles.create": async (_f, _seed, way) => {
        const name = `made-${label(way)}`;
        return { input: { name, instructions: "Make things.", tools: ["read"], skills: [] }, names: [name] };
    },
    "roles.change": async (fixture, _seed, way) => {
        const name = `changed-${label(way)}`;
        await fixture.invoke("roles.create", { name, instructions: "Before.", tools: ["read"], skills: [] });
        return { input: { name, instructions: "After." }, names: [name] };
    },
    "roles.restore": async (fixture) => {
        await fixture.invoke("roles.change", { name: "gp", instructions: "Changed for the test." });
        return { input: { name: "gp" } };
    },
    "roles.remove": async (fixture, _seed, way) => {
        const name = `removed-${label(way)}`;
        await fixture.invoke("roles.create", { name, instructions: "Soon gone.", tools: ["read"], skills: [] });
        return { input: { name } };
    },
    "workspaces.register": async (fixture, _seed, way) => {
        const path = await fixture.folder(`register-${label(way)}`);
        return { input: { path }, names: [path] };
    },
    "workspaces.unregister": async (fixture, _seed, way) => {
        const path = await fixture.folder(`unregister-${label(way)}`);
        await fixture.invoke("workspaces.register", { path });
        return { input: { path } };
    },
};

async function seedConversation(fixture: Fixture): Promise<Seed> {
    const conversationId = await fixture.settledConversation("seed");
    const submitted = { conversationId, content: "seeded", requestId: "seeded" };
    const { submissionId } = (await fixture.invoke("conversations.submit", submitted)) as { submissionId: string };
    await fixture.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_WAIT_MS });
    await until(
        async () =>
            ((await fixture.invoke("conversations.get", { conversationId })) as { status: string }).status === "idle",
        "the seed conversation to be idle",
    );
    return { conversationId, submissionId };
}

describe("catalogue through both listeners", () => {
    it("answers every product operation through both listeners as in-process", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const fixture = await startFixture();
        const seed = await seedConversation(fixture);
        const called = fixture.daemon.catalogue
            .list()
            .filter(({ name }) => name !== STREAM_OPERATION && !name.startsWith(TEST_OPERATION_PREFIX));
        const ordered = [...called.filter((op) => op.kind === "read"), ...called.filter((op) => op.kind === "control")];

        for (const { name, kind } of ordered) {
            const build = INPUT_BUILDERS[name];
            assert.ok(build, `operation ${name} has an input builder`);
            const outcomes: unknown[] = [];
            for (const way of WAYS) {
                const { input, names } = await build(fixture, seed, way);
                const before = kind === "read" ? await fixture.stateSnapshot() : undefined;
                const outcome = await fixture.call(way, name, input);
                assert.equal(outcome.status, 200, `${name} ${way}: ${JSON.stringify(outcome.body)}`);
                if (kind === "read")
                    assert.deepEqual(await fixture.stateSnapshot(), before, `${name} ${way} reads only`);
                outcomes.push(comparable(outcome.body, names));
            }
            assert.deepEqual(outcomes[1], outcomes[0], `${name} over the local socket answers as in-process`);
            assert.deepEqual(outcomes[2], outcomes[0], `${name} over the network listener answers as in-process`);
        }
    });

    it("answers test.createConversation, an operation with no listener code, through both listeners", async () => {
        const fixture = await startFixture();
        const outcomes: unknown[] = [];

        for (const way of WAYS) {
            const input = { key: `key-${label(way)}`, cwd: fixture.env.dataDir };
            const outcome = await fixture.call(way, "test.createConversation", input);
            assert.equal(outcome.status, 200, `${way}: ${JSON.stringify(outcome.body)}`);
            outcomes.push(comparable(outcome.body));
        }

        assert.deepEqual(outcomes[0], { result: { conversationId: "<id>", created: true } });
        assert.deepEqual(outcomes[1], outcomes[0]);
        assert.deepEqual(outcomes[2], outcomes[0]);
        assert.equal((await fixture.ctx.host.listConversations()).length, WAYS.length);
    });
});

type HeldStop = { component: DaemonComponent; entered: Promise<void>; release(): void };

/** A component placed after the listeners: components stop in reverse, so the listeners stay open while it is held. */
function heldStop(): HeldStop {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    return {
        component: {
            name: "held stop",
            async stop() {
                entered.resolve();
                await released.promise;
            },
        },
        entered: entered.promise,
        release: () => released.resolve(),
    };
}

/** Calls in-process and through each listener; each listener answers with the in-process status, code and message. */
async function assertErrorThroughListeners(
    call: (way: Way) => Promise<Outcome>,
    code: ServiceErrorCode,
): Promise<void> {
    const inProcess = await call("in-process");
    const throughListeners = [await call("local socket"), await call("network listener")];
    assert.equal(inProcess.status, STATUS_OF[code], JSON.stringify(inProcess.body));
    assert.equal((inProcess.body as { error: { code: string } }).error.code, code);
    for (const outcome of throughListeners) assert.deepEqual(outcome, inProcess);
}

describe("error outcomes through both listeners", () => {
    it("answers invalid input, an unknown conversation, a busy submit and a conflicting create as in-process", async () => {
        const fixture = await startFixture();
        const busyConversation = await fixture.runningConversation("busy");
        const callEach = (name: string, input: (way: Way) => unknown) => (way: Way) =>
            fixture.call(way, name, input(way));

        await assertErrorThroughListeners(
            callEach("conversations.get", () => ({})),
            "invalid_input",
        );
        await assertErrorThroughListeners(
            callEach("conversations.get", () => ({ conversationId: "9999" })),
            "not_found",
        );
        const rejectIfBusy = (way: Way) => ({
            conversationId: busyConversation,
            content: "later",
            requestId: `reject-${label(way)}`,
            busyMode: "reject",
        });
        await assertErrorThroughListeners(callEach("conversations.submit", rejectIfBusy), "busy");
        const sameName = () => ({ name: "gp", instructions: "Another gp.", tools: [], skills: [] });
        await assertErrorThroughListeners(callEach("roles.create", sameName), "conflict");
    });

    it("answers 503 unavailable while the daemon is stopping", async () => {
        const held = heldStop();
        const fixture = await startFixture({ lastComponents: [held.component] });
        const stopped = fixture.daemon.stop();
        await held.entered;
        try {
            await assertErrorThroughListeners((way) => fixture.call(way, "conversations.list", {}), "unavailable");
        } finally {
            held.release();
        }
        assert.equal(await stopped, 0);
    });

    it("answers 500 internal for a run that fails on storage", { timeout: TEST_TIMEOUT_MS }, async () => {
        async function failingCall(way: Way): Promise<Outcome> {
            const held = heldStop();
            const fixture = await startFixture({ lastComponents: [held.component] });
            try {
                await fixture.invoke("test.failStorage", {});
                return await fixture.call(way, "test.createConversation", { key: "doomed", cwd: fixture.env.dataDir });
            } finally {
                held.release();
            }
        }

        await assertErrorThroughListeners(failingCall, "internal");
    });
});

const FOREIGN_HEADERS: OutgoingHttpHeaders = {
    origin: "https://elsewhere.example",
    host: "attacker.example:9999",
    referer: "https://elsewhere.example/page",
};
const JSON_HEADERS: OutgoingHttpHeaders = { "content-type": "application/json" };
const LISTENERS = ["local socket", "network listener"] as const;

function corsHeaderNames(headers: IncomingHttpHeaders): string[] {
    return Object.keys(headers).filter((name) => name.startsWith("access-control-"));
}

describe("no access checks through both listeners", () => {
    it("answers calls with foreign Origin and Host headers and no credentials as without them, with no CORS header", async () => {
        const fixture = await startFixture();
        const requests = [
            { method: "POST", path: "/operations/daemon.status", body: "{}" },
            { method: "POST", path: "/operations/conversations.list", body: "{}" },
            { method: "POST", path: "/operations/conversations.get", body: '{"conversationId":"9999"}' },
            { method: "POST", path: "/operations/no.such", body: "{}" },
            { method: "OPTIONS", path: "/operations/daemon.status" },
        ];

        for (const way of LISTENERS) {
            for (const { method, path, body } of requests) {
                const target = fixture.targetOf(way);
                const plain = await send(target, method, path, JSON_HEADERS, body);
                const foreign = await send(target, method, path, { ...JSON_HEADERS, ...FOREIGN_HEADERS }, body);

                const what = `${method} ${path} over the ${way}`;
                assert.deepEqual([foreign.status, foreign.body], [plain.status, plain.body], what);
                assert.deepEqual(corsHeaderNames(foreign.headers), [], `${what} sends no CORS header`);
                assert.deepEqual(corsHeaderNames(plain.headers), [], `${what} sends no CORS header`);
            }
        }
    });
});
