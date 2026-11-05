/**
 * The front desk through each listener of a real daemon (S-001 AC-021.4, AC-023.1, S-002 AC-012.6): `desk.get` and
 * `conversations.list` answer alike in-process, over the local socket and over the network listener, and input to the
 * front desk from both ways in lands in one transcript, in admission order, each input with its way in.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller } from "../../src/service/operations.ts";
import { startDaemon } from "../support/daemon_process.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const LOOPBACK = "127.0.0.1";
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
const quietLogger = createLogger({ stream: { write: () => true } });

const COMMAND_LINE = { kind: "team_member", wayIn: "command line" };
const WEB_INTERFACE = { kind: "team_member", wayIn: "web interface" };

type Listener = "in-process" | "local socket" | "network listener";
type Entry = { kind: string; data: unknown };
type DeskView = { conversationId: string; seat: unknown };
type Listing = { id: string; isFrontDesk: boolean };
type Messages = { content: string; actor: unknown }[];

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

type HttpTarget = { socketPath: string } | { host: string; port: number };

function post(target: HttpTarget, name: string, input: unknown): Promise<{ status: number; result: unknown }> {
    return new Promise((resolve, reject) => {
        const options = {
            ...target,
            method: "POST",
            path: `/operations/${name}`,
            headers: { "content-type": "application/json" },
        };
        const call = request(options, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: unknown };
                resolve({ status: response.statusCode ?? 0, result: body.result });
            });
            response.once("error", reject);
        });
        call.once("error", reject);
        call.end(JSON.stringify(input));
    });
}

type Fixture = {
    call(listener: Listener, name: string, input: unknown): Promise<unknown>;
    deskId(): Promise<string>;
    /** Submits over a listener and waits until the input is done and the conversation idle again. */
    submitAndSettle(listener: Listener, conversationId: string, content: string): Promise<void>;
    messages(listener: Listener, conversationId: string): Promise<Messages>;
};

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
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    const network = createNetworkListenerComponent({ freePort: true });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, networkSection],
        components: [agents.component, jobs.component, desk.component, createLocalSocketComponent(), network],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations],
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

    async function call(listener: Listener, name: string, input: unknown): Promise<unknown> {
        if (listener === "in-process") return daemon.catalogue.invoke(name, input, IN_PROCESS);
        const address = network.address();
        assert.ok(address, "the network listener is running");
        const answer = await post(listener === "local socket" ? { socketPath } : address, name, input);
        assert.equal(answer.status, 200, `${name} over the ${listener}`);
        return answer.result;
    }

    const deskId = async () => ((await call("in-process", "desk.get", {})) as DeskView).conversationId;

    async function waitIdle(conversationId: string): Promise<void> {
        const isIdle = async () =>
            ((await call("in-process", "conversations.get", { conversationId })) as { status: string }).status ===
            "idle";
        await until(isIdle, `conversation ${conversationId} to be idle`);
    }

    async function submitAndSettle(listener: Listener, conversationId: string, content: string) {
        const input = { conversationId, content, requestId: `${content}-request` };
        const { submissionId } = (await call(listener, "conversations.submit", input)) as { submissionId: string };
        const waited = (await call("in-process", "submissions.wait", { submissionId, timeoutMs: WAIT_TIMEOUT_MS })) as {
            state: string;
        };
        assert.equal(waited.state, "done", `submission ${submissionId} is done`);
        await waitIdle(conversationId);
    }

    async function messages(listener: Listener, conversationId: string): Promise<Messages> {
        const page = (await call(listener, "conversations.entries", { conversationId, limit: 200 })) as {
            entries: Entry[];
        };
        return page.entries
            .filter((entry) => entry.kind === STEER_RECORD_KIND)
            .map((entry) => entry.data as Messages[0]);
    }

    return { call, deskId, submitAndSettle, messages };
}

describe("the front desk through each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    it("returns the same front desk from desk.get in-process, over the local socket and over the network", async () => {
        const fixture = await startFixture();

        const views = [];
        for (const listener of ["in-process", "local socket", "network listener"] as const)
            views.push(await fixture.call(listener, "desk.get", {}));

        assert.deepEqual(views[1], views[0]);
        assert.deepEqual(views[2], views[0]);
    });

    it("marks only the front desk in conversations.list in-process and over each listener", async () => {
        const fixture = await startFixture();
        const deskId = await fixture.deskId();
        await fixture.call("local socket", "jobs.create", { text: "other work", idempotencyKey: "other" });

        for (const listener of ["in-process", "local socket", "network listener"] as const) {
            const listed = (await fixture.call(listener, "conversations.list", {})) as Listing[];
            assert.ok(listed.length >= 2, `${listener}: the job's lead is listed beside the front desk`);
            assert.deepEqual(
                listed.filter((conversation) => conversation.isFrontDesk).map((conversation) => conversation.id),
                [deskId],
                listener,
            );
        }
    });

    it("shows input from the network listener to the local socket and orders it before the next input", async () => {
        const fixture = await startFixture();
        const deskId = await fixture.deskId();

        await fixture.submitAndSettle("network listener", deskId, "first from the web");
        const seen = await fixture.messages("local socket", deskId);
        assert.deepEqual(
            seen.map((message) => message.content),
            ["first from the web"],
        );
        await fixture.submitAndSettle("local socket", deskId, "second from the command line");

        const transcript = (await fixture.messages("network listener", deskId)).map(({ content, actor }) => ({
            content,
            actor,
        }));
        assert.deepEqual(transcript, [
            { content: "first from the web", actor: WEB_INTERFACE },
            { content: "second from the command line", actor: COMMAND_LINE },
        ]);
    });

    it("records command line for the local socket and web interface for the network listener", async () => {
        const fixture = await startFixture();
        const deskId = await fixture.deskId();

        await fixture.submitAndSettle("local socket", deskId, "over the socket");
        await fixture.submitAndSettle("network listener", deskId, "over the network");

        const actors = Object.fromEntries(
            (await fixture.messages("in-process", deskId)).map((message) => [message.content, message.actor]),
        );
        assert.deepEqual(actors["over the socket"], COMMAND_LINE);
        assert.deepEqual(actors["over the network"], WEB_INTERFACE);
    });
});

describe("the test daemon child", () => {
    it("answers desk.get once it is ready", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const child = startDaemon({ hermetic: env });
        try {
            await child.ready;
            const view = (await child.invoke("desk.get", {})) as DeskView;
            assert.equal(typeof view.conversationId, "string");
        } finally {
            child.signal("SIGTERM");
            await child.exited;
        }
    });
});
