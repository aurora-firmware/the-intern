/**
 * The caller and a job's origin recorded through each listener of a real daemon (S-003 REQ-007, S-002 AC-012.5): every
 * call over the local socket is a team member with the way in `command line`, every call over the network listener
 * one with `web interface`, and nothing in the request changes that.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { type OutgoingHttpHeaders, request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const SETTLE_WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
const ENTRIES_LIMIT = 200;
const LOOPBACK = "127.0.0.1";
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
const CLI: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const quietLogger = createLogger({ stream: { write: () => true } });
const JSON_HEADERS: OutgoingHttpHeaders = { "content-type": "application/json" };

const COMMAND_LINE = { kind: "team_member", wayIn: "command line" };
const WEB_INTERFACE = { kind: "team_member", wayIn: "web interface" };
const COMMAND_LINE_REQUEST = { kind: "request", wayIn: "command line" };
const WEB_INTERFACE_REQUEST = { kind: "request", wayIn: "web interface" };

type Listener = "local socket" | "network listener";
type HttpTarget = { socketPath: string } | { host: string; port: number };
type Answer = {
    status: number;
    /** The client side's port of the connection the answer came over, which the daemon sees as the peer's port. */
    localPort: number | undefined;
    body: { result?: unknown; error?: { code: string; message: string } };
};
type CreatedJob = {
    number: string;
    statedBy?: string;
    leadConversation: string;
    request: { origin: unknown };
};
type Entry = { kind: string; data: unknown };

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

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

function post(target: HttpTarget, name: string, input: unknown, headers: OutgoingHttpHeaders = {}) {
    return new Promise<Answer>((resolve, reject) => {
        const options = {
            ...target,
            method: "POST",
            path: `/operations/${name}`,
            headers: { ...JSON_HEADERS, ...headers },
        };
        const call = request(options, (response) => {
            const localPort = response.socket.localPort;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({ status: response.statusCode ?? 0, localPort, body: JSON.parse(text) });
            });
            response.once("error", reject);
        });
        call.once("error", reject);
        call.end(JSON.stringify(input));
    });
}

type Fixture = {
    invoke(name: string, input: unknown): Promise<unknown>;
    /** Calls an operation over a listener and returns its result, failing the test on an error answer. */
    call(listener: Listener, name: string, input: unknown, headers?: OutgoingHttpHeaders): Promise<unknown>;
    post(listener: Listener, name: string, input: unknown, headers?: OutgoingHttpHeaders): Promise<Answer>;
    /** Starts a job in-process and waits until its lead conversation is idle. */
    idleConversation(jobId: string): Promise<string>;
    /** Submits input over a listener and waits until it is done and the conversation idle again. */
    submitAndSettle(listener: Listener, conversationId: string, content: string, extra?: Extra): Promise<void>;
    entries(conversationId: string): Promise<Entry[]>;
};

type Extra = { input?: Record<string, unknown>; headers?: OutgoingHttpHeaders };

async function startFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
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

    const postTo = (listener: Listener, name: string, input: unknown, headers?: OutgoingHttpHeaders) =>
        post(targetOf(listener), name, input, headers);

    async function call(listener: Listener, name: string, input: unknown, headers?: OutgoingHttpHeaders) {
        const answer = await postTo(listener, name, input, headers);
        assert.equal(answer.status, 200, `${name} over the ${listener}: ${JSON.stringify(answer.body)}`);
        return answer.body.result;
    }

    async function waitIdle(conversationId: string): Promise<void> {
        const isIdle = async () =>
            ((await invoke("conversations.get", { conversationId })) as { status: string }).status === "idle";
        await until(isIdle, `conversation ${conversationId} to be idle`);
    }

    async function waitDone(submissionId: string): Promise<void> {
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_WAIT_MS })) as {
            state: string;
        };
        assert.equal(waited.state, "done", `submission ${submissionId} is done`);
    }

    async function idleConversation(jobId: string): Promise<string> {
        const created = await daemon.catalogue.invoke("jobs.create", { text: "hello", idempotencyKey: jobId }, CLI);
        const conversationId = (created as { leadConversation: string }).leadConversation;
        await waitIdle(conversationId);
        const settle = { conversationId, content: "settle", requestId: `settle-${jobId}` };
        await waitDone(((await invoke("conversations.submit", settle)) as { submissionId: string }).submissionId);
        await waitIdle(conversationId);
        return conversationId;
    }

    async function submitAndSettle(listener: Listener, conversationId: string, content: string, extra: Extra = {}) {
        const input = { ...extra.input, conversationId, content, requestId: `${content}-request` };
        const result = (await call(listener, "conversations.submit", input, extra.headers)) as { submissionId: string };
        await waitDone(result.submissionId);
        await waitIdle(conversationId);
    }

    async function entries(conversationId: string): Promise<Entry[]> {
        const page = (await invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
            entries: Entry[];
            next?: string;
        };
        assert.equal(page.next, undefined, "every entry of the conversation fits one page");
        return page.entries;
    }

    return { invoke, call, post: postTo, idleConversation, submitAndSettle, entries };
}

function seatActors(entries: readonly Entry[]): unknown[] {
    return entries
        .filter((entry) => entry.kind === SEAT_RECORD_KIND)
        .map((entry) => (entry.data as { actor: unknown }).actor);
}

/** Input fields that claim the way in `web interface` or an agent actor; no operation's input names a caller. */
function inputClaims(conversationId: string): Record<string, unknown> {
    const agent = { kind: "agent", conversationId, role: "bob" };
    return { wayIn: "web interface", actor: agent, caller: { actor: agent } };
}

/** Request headers that claim the way in `web interface` or an agent actor. */
function headerClaims(conversationId: string): OutgoingHttpHeaders {
    return {
        "x-intern-way-in": "web interface",
        "x-intern-actor": JSON.stringify({ kind: "agent", conversationId, role: "bob" }),
        "user-agent": "web interface",
    };
}

async function originOf(fixture: Fixture, conversationId: string): Promise<unknown> {
    return ((await fixture.invoke("conversations.get", { conversationId })) as { origin: unknown }).origin;
}

/** The actor each submitted message names, by its content. */
function messageActors(entries: readonly Entry[]): Record<string, unknown> {
    const messages = entries.filter((entry) => entry.kind === STEER_RECORD_KIND);
    const pairs = messages.map((entry) => entry.data as { content: string; actor: unknown });
    return Object.fromEntries(pairs.map(({ content, actor }) => [content, actor]));
}

describe("the way in recorded through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("records a seat change over each listener as a team member with that listener's way in", async () => {
        const fixture = await startFixture();
        const conversationId = await fixture.idleConversation("seated");

        await fixture.call("local socket", "conversations.seat", { conversationId, role: "gp" });
        await fixture.call("network listener", "conversations.seat", { conversationId, role: "bob" });

        const changes = seatActors(await fixture.entries(conversationId)).slice(1);
        assert.deepEqual(changes, [COMMAND_LINE, WEB_INTERFACE]);
    });

    it("records input submitted over each listener as a team member with that listener's way in", async () => {
        const fixture = await startFixture();
        const conversationId = await fixture.idleConversation("submitted");

        await fixture.submitAndSettle("local socket", conversationId, "over the socket");
        await fixture.submitAndSettle("network listener", conversationId, "over the network");

        const actors = messageActors(await fixture.entries(conversationId));
        assert.deepEqual(actors["over the socket"], COMMAND_LINE);
        assert.deepEqual(actors["over the network"], WEB_INTERFACE);
    });

    it("records a team member with command line when a local socket call's input claims another caller", async () => {
        const fixture = await startFixture();
        const conversationId = await fixture.idleConversation("claimed-in-input");
        const claims = inputClaims(conversationId);

        await fixture.call("local socket", "conversations.seat", { ...claims, conversationId, role: "gp" });
        await fixture.submitAndSettle("local socket", conversationId, "claiming", { input: claims });
        const created = (await fixture.call("local socket", "jobs.create", { ...claims, text: "go" })) as CreatedJob;

        const entries = await fixture.entries(conversationId);
        assert.deepEqual(seatActors(entries).at(-1), COMMAND_LINE);
        assert.deepEqual(messageActors(entries).claiming, COMMAND_LINE);
        assert.deepEqual(await originOf(fixture, created.leadConversation), COMMAND_LINE_REQUEST);
    });

    it("records a team member with command line when a local socket call's headers claim another caller", async () => {
        const fixture = await startFixture();
        const conversationId = await fixture.idleConversation("claimed-in-headers");
        const headers = headerClaims(conversationId);

        await fixture.call("local socket", "conversations.seat", { conversationId, role: "gp" }, headers);
        await fixture.submitAndSettle("local socket", conversationId, "claiming", { headers });
        const created = (await fixture.call("local socket", "jobs.create", { text: "go" }, headers)) as CreatedJob;

        const entries = await fixture.entries(conversationId);
        assert.deepEqual(seatActors(entries).at(-1), COMMAND_LINE);
        assert.deepEqual(messageActors(entries).claiming, COMMAND_LINE);
        assert.deepEqual(await originOf(fixture, created.leadConversation), COMMAND_LINE_REQUEST);
    });
});

describe("a job's origin through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("records command line alone for the local socket and the TCP peer for the network listener", async () => {
        const fixture = await startFixture();

        const local = await fixture.post("local socket", "jobs.create", { text: "over the socket" });
        const network = await fixture.post("network listener", "jobs.create", { text: "over the network" });

        assert.equal(local.status, 200);
        assert.equal(network.status, 200);
        assert.deepEqual((local.body.result as CreatedJob).request.origin, COMMAND_LINE_REQUEST);
        assert.ok(network.localPort, "the client connection has a local port");
        assert.deepEqual((network.body.result as CreatedJob).request.origin, {
            ...WEB_INTERFACE_REQUEST,
            observed: { remoteAddress: LOOPBACK, remotePort: network.localPort },
        });
    });

    it("refuses a jobs.create call naming an origin as invalid_input naming origin and uses no number", async () => {
        const fixture = await startFixture();
        const before = await fixture.invoke("conversations.list", {});
        const origin = { kind: "request", wayIn: "email" };

        for (const listener of ["local socket", "network listener"] as const) {
            const answer = await fixture.post(listener, "jobs.create", { text: "claimed", origin });
            assert.equal(answer.status, 400, listener);
            assert.equal(answer.body.error?.code, "invalid_input", listener);
            assert.match(answer.body.error?.message ?? "", /origin/, listener);
        }

        assert.deepEqual(await fixture.invoke("conversations.list", {}), before);
        const local = (await fixture.call("local socket", "jobs.create", { text: "asked" })) as CreatedJob;
        const network = (await fixture.call("network listener", "jobs.create", { text: "asked" })) as CreatedJob;
        assert.equal(local.number, "C-1");
        assert.equal(network.number, "W-1");
    });

    it("records statedBy as stated for a call without an origin over each listener", async () => {
        const fixture = await startFixture();

        const local = (await fixture.call("local socket", "jobs.create", {
            text: "asked",
            statedBy: "Ana",
        })) as CreatedJob;
        const network = (await fixture.call("network listener", "jobs.create", {
            text: "asked",
            statedBy: "Ben",
        })) as CreatedJob;

        assert.equal(local.statedBy, "Ana");
        assert.equal(network.statedBy, "Ben");
        assert.deepEqual(local.request.origin, COMMAND_LINE_REQUEST);
        assert.equal((network.request.origin as { observed?: unknown }).observed !== undefined, true);
    });

    it("records the TCP connection's address and port when X-Forwarded-For names another address", async () => {
        const fixture = await startFixture();

        const answer = await fixture.post(
            "network listener",
            "jobs.create",
            { text: "forwarded" },
            { "x-forwarded-for": "203.0.113.9" },
        );

        assert.equal(answer.status, 200);
        assert.deepEqual((answer.body.result as CreatedJob).request.origin, {
            ...WEB_INTERFACE_REQUEST,
            observed: { remoteAddress: LOOPBACK, remotePort: answer.localPort },
        });
    });
});
