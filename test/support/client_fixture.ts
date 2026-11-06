/**
 * What the client service tests share: a real daemon with both listeners over a fake model, a client over each
 * listener, and the waiting helpers. A test file calls `cleanupFixtures` after each test.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type Client, createClient } from "../../src/client/client.ts";
import { nodeTransport } from "../../src/client/node_transport.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createFakeModel, type FakeTranscript } from "./fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
export const TEST_TIMEOUT_MS = 90_000;
const LOOPBACK = "127.0.0.1";
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
const quietLogger = createLogger({ stream: { write: () => true } });
export const LISTENERS = ["local socket", "network listener"] as const;

export type Listener = (typeof LISTENERS)[number];

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];

/** Stops the daemons the fixtures started and removes their fake models and directories. */
export async function cleanupFixtures(): Promise<void> {
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

export type Fixture = {
    daemon: RunningDaemon;
    invoke(name: string, input: unknown): Promise<unknown>;
    /** The socket path or base URL the client over the listener calls. */
    targetOf(listener: Listener): string;
    clientOver(listener: Listener): Client;
};

export async function startFixture(delayMs: (transcript: FakeTranscript) => number = () => 0): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs });
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
    await until(() => daemon.phase() === "ready", "the daemon to be ready");

    function targetOf(listener: Listener): string {
        if (listener === "local socket") return localSocketPath(env.runtimeDir);
        const address = network.address();
        assert.ok(address, "the network listener is running");
        return `http://${address.host}:${address.port}`;
    }

    function clientOver(listener: Listener): Client {
        const target = targetOf(listener);
        return createClient(nodeTransport(listener === "local socket" ? { socketPath: target } : { baseUrl: target }));
    }

    return {
        daemon,
        invoke: (name, input) => daemon.catalogue.invoke(name, input, IN_PROCESS),
        targetOf,
        clientOver,
    };
}

/** Reads the subscription to its end, after the daemon has been told to stop. */
export async function readUntilEnd(feed: AsyncGenerator<unknown, { end: string }>) {
    const items: unknown[] = [];
    for (;;) {
        const read = await feed.next();
        if (read.done) return { items, end: read.value };
        items.push(read.value);
    }
}

/** A job's lead conversation, once it is idle. */
export async function idleConversation(fixture: Fixture, listener: Listener, text: string): Promise<string> {
    const created = (await fixture.clientOver(listener).invoke("jobs.create", { text })) as {
        leadConversation: string;
    };
    const conversationId = created.leadConversation;
    const isIdle = async () =>
        ((await fixture.invoke("conversations.get", { conversationId })) as { status: string }).status === "idle";
    await until(isIdle, `conversation ${conversationId} to be idle`);
    return conversationId;
}
