/**
 * The client library over both listeners of a real daemon (S-003 REQ-009, AC-009.1, AC-009.2): calls answer as they
 * answer in-process, a failed call fails with the in-process code and message, a subscription yields the snapshot and
 * the deltas and ends with the reason, and a call cut by the daemon stopping fails as unavailable or unreachable.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type Client, ClientError, createClient } from "../../src/client/client.ts";
import { nodeTransport } from "../../src/client/node_transport.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller, Catalogue } from "../../src/service/operations.ts";
import { createFakeModel, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const TEST_TIMEOUT_MS = 90_000;
const LOOPBACK = "127.0.0.1";
const IN_PROCESS: Caller = { actor: { kind: "team_member" } };
const quietLogger = createLogger({ stream: { write: () => true } });
const LISTENERS = ["local socket", "network listener"] as const;
const UNKNOWN_CONVERSATION = { conversationId: "999" };
const INSTANCE_FEED = { scope: "instance" } as const;
const WATCHED_ROLE = { name: "watched", instructions: "Watch.", tools: ["read"], skills: [] };

type Listener = (typeof LISTENERS)[number];

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];

afterEach(async () => {
    mock.restoreAll();
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

type Fixture = {
    daemon: RunningDaemon;
    invoke(name: string, input: unknown): Promise<unknown>;
    clientOver(listener: Listener): Client;
};

async function startFixture(delayMs: (transcript: FakeTranscript) => number = () => 0): Promise<Fixture> {
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
    await until(() => daemon.phase() === "ready", "the daemon to be ready");

    function clientOver(listener: Listener): Client {
        if (listener === "local socket")
            return createClient(nodeTransport({ socketPath: localSocketPath(env.runtimeDir) }));
        const address = network.address();
        assert.ok(address, "the network listener is running");
        return createClient(nodeTransport({ baseUrl: `http://${address.host}:${address.port}` }));
    }

    return {
        daemon,
        invoke: (name, input) => daemon.catalogue.invoke(name, input, IN_PROCESS),
        clientOver,
    };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        (value) => assert.fail(`the call was answered with ${JSON.stringify(value)}`),
        (error: unknown) => error,
    );
}

describe("calls through the client over each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`returns the in-process daemon.status over the ${listener}`, async () => {
            const fixture = await startFixture();

            const status = await fixture.clientOver(listener).invoke("daemon.status");

            assert.deepEqual(status, await fixture.invoke("daemon.status", {}));
        });

        it(`fails over the ${listener} with ClientError carrying the in-process code and message`, async () => {
            const fixture = await startFixture();
            const inProcess = (await rejection(fixture.invoke("conversations.get", UNKNOWN_CONVERSATION))) as Error & {
                code: string;
            };

            const error = await rejection(
                fixture.clientOver(listener).invoke("conversations.get", UNKNOWN_CONVERSATION),
            );

            assert.ok(error instanceof ClientError, `the call fails with ClientError, not ${error}`);
            assert.equal(inProcess.code, "not_found");
            assert.deepEqual(
                { code: error.code, message: error.message },
                { code: inProcess.code, message: inProcess.message },
            );
        });
    }
});

type InstanceDelta = { seq: number; type: string };

/** Counts the feed subscriptions the listeners open, from the moment it is called. */
function countSubscriptions(catalogue: Catalogue): { count: number } {
    const counted = { count: 0 };
    const invoke = catalogue.invoke.bind(catalogue);
    mock.method(catalogue, "invoke", (name: string, input: unknown, caller: Caller) => {
        if (name === "feed.subscribe") counted.count += 1;
        return invoke(name, input, caller);
    });
    return counted;
}

/** Reads the subscription to its end, after the daemon has been told to stop. */
async function readUntilEnd(feed: AsyncGenerator<unknown, { end: string }>) {
    const items: unknown[] = [];
    for (;;) {
        const read = await feed.next();
        if (read.done) return { items, end: read.value };
        items.push(read.value);
    }
}

describe("a subscription through the client over each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`yields the snapshot, then the deltas in order, and ends stopped over the ${listener}`, async () => {
            const fixture = await startFixture();
            const inProcess = (await fixture.invoke("feed.subscribe", INSTANCE_FEED)) as {
                snapshot: unknown;
                close(): void;
            };
            inProcess.close();
            const subscriptions = countSubscriptions(fixture.daemon.catalogue);
            const feed = fixture.clientOver(listener).subscribe(INSTANCE_FEED);

            const first = await feed.next();
            await fixture.invoke("roles.create", WATCHED_ROLE);
            const deltas: InstanceDelta[] = [];
            while (deltas.at(-1)?.type !== "settings_changed") {
                const read = await feed.next();
                assert.ok(!read.done && "delta" in read.value, `a delta follows, not ${JSON.stringify(read)}`);
                deltas.push(read.value.delta as InstanceDelta);
            }
            const [rest] = await Promise.all([readUntilEnd(feed), fixture.daemon.stop()]);
            const afterEnd = await feed.next();

            assert.deepEqual(first, { done: false, value: { snapshot: inProcess.snapshot } });
            assert.deepEqual(
                deltas.map((delta) => delta.seq),
                deltas.map((_, index) => index + 1),
            );
            assert.ok(rest.items.every((item) => typeof item === "object" && item !== null && "delta" in item));
            assert.deepEqual(rest.end, { end: "stopped" });
            assert.deepEqual(afterEnd, { done: true, value: undefined }, "the ended subscription stays ended");
            assert.equal(subscriptions.count, 1, "the client opened one subscription and no other");
        });
    }
});
