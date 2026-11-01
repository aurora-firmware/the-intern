import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { type IncomingMessage, request, Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const RUN_DELAY_MS = 60_000;
const STOP_TEST_TIMEOUT_MS = STOP_BOUND_MS + 10_000;
const LOOPBACK = "127.0.0.1";
const UNOWNED_ADDRESS = "203.0.113.1";
const caller = { actor: { kind: "team_member" as const } };

type FakeModel = ReturnType<typeof createFakeModel>;
type Answer = { status: number; body: string };

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelsFor(fake: FakeModel): Models {
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation, "the fake model's api is registered");
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return models;
}

type Agents = Awaited<ReturnType<typeof createAgentsComponent>>;

type Fixture = {
    env: HermeticEnv;
    lines: string[];
    modelId: string;
    configure(text: string): Promise<void>;
    start(components: readonly DaemonComponent[], agents?: Agents): RunningDaemon;
};

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => RUN_DELAY_MS });
    fakes.push(fake);
    const lines: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (chunk) => lines.push(String(chunk)) } });
    return {
        env,
        lines,
        modelId: `${fake.getModel().provider}/${fake.getModel().id}`,
        configure: (text) => writeFile(join(env.configDir, "config.toml"), text),
        start(components, agents) {
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: env.env,
                homeDir: env.root,
                logger,
                sections: [...(agents?.sections ?? []), networkSection],
                operations: agents?.operations ?? [],
                prepareModels: () => modelsFor(fake),
                components,
            });
            daemons.push(daemon);
            return daemon;
        },
    };
}

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

function open(
    target: { socketPath: string } | { host: string; port: number },
    method: string,
    path: string,
    body?: unknown,
): Promise<IncomingMessage> {
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    const call = request({ ...target, method, path, headers });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
        call.once("response", resolve);
        call.once("error", reject);
    });
    call.end(body === undefined ? undefined : JSON.stringify(body));
    return response;
}

function readAll(response: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.once("error", reject);
        response.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

async function call(
    target: { socketPath: string } | { host: string; port: number },
    method: string,
    path: string,
    body?: unknown,
): Promise<Answer> {
    const response = await open(target, method, path, body);
    return { status: response.statusCode ?? 0, body: await readAll(response) };
}

function addressIn(listener: { address(): { host: string; port: number } | undefined }) {
    const address = listener.address();
    assert.ok(address, "the network listener is running");
    return address;
}

async function occupyPort(): Promise<{ port: number; close(): void }> {
    const occupier = createServer();
    await new Promise<void>((resolve) => occupier.listen(0, LOOPBACK, resolve));
    const address = occupier.address();
    assert.ok(address && typeof address === "object");
    return { port: address.port, close: () => occupier.close() };
}

describe("network listener", () => {
    it("listens on no TCP port when the configuration has no network section", async () => {
        const fixture = await createFixture();
        const listens: unknown[][] = [];
        const listen = Server.prototype.listen;
        mock.method(Server.prototype, "listen", function (this: Server, ...args: Parameters<Server["listen"]>) {
            listens.push(args);
            return listen.apply(this, args);
        });
        const listener = createNetworkListenerComponent({ freePort: true });

        const daemon = fixture.start([listener]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.equal(listener.address(), undefined);
        assert.deepEqual(listens, []);
    });

    it("answers daemon.status on the configured address and logs the address and the port in use", async () => {
        const fixture = await createFixture();
        await fixture.configure(`[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
        const listener = createNetworkListenerComponent({ freePort: true });

        const daemon = fixture.start([listener]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const { host, port } = addressIn(listener);
        const answer = await call({ host, port }, "POST", "/operations/daemon.status", {});

        assert.equal(host, LOOPBACK);
        assert.notEqual(port, 8080, "the free-port switch replaces the configured port");
        assert.equal(answer.status, 200);
        assert.equal(JSON.parse(answer.body).result.phase, "ready");
        const logged = fixture.lines.find((line) => line.includes("network listener") && line.includes(`${port}`));
        assert.ok(logged, "a line names the port in use");
        assert.ok(logged.includes(LOOPBACK), "the line names the address");
    });

    it("exits 1 naming the address, the port and the reason, with no bob.sock left, when the port is in use", async () => {
        const fixture = await createFixture();
        const occupier = await occupyPort();
        await fixture.configure(`[network]\naddress = "${LOOPBACK}"\nport = ${occupier.port}\n`);

        const daemon = fixture.start([createLocalSocketComponent(), createNetworkListenerComponent()]);

        assert.equal(await daemon.exited, 1);
        const failure = fixture.lines.find((line) => line.includes("startup failed"));
        assert.ok(failure, "startup logs the failing step");
        assert.match(failure, /step=8 name="start components"/);
        assert.ok(failure.includes(`${LOOPBACK}:${occupier.port}`), "the failure names the address and the port");
        assert.match(failure, /EADDRINUSE/);
        const socketPath = localSocketPath(fixture.env.runtimeDir);
        assert.equal(await exists(socketPath), false);
        await assert.rejects(call({ socketPath }, "POST", "/operations/daemon.status", {}));
        occupier.close();
    });

    it("exits 1 naming the address, the port and the reason when the address is not on the machine", async () => {
        const fixture = await createFixture();
        await fixture.configure(`[network]\naddress = "${UNOWNED_ADDRESS}"\nport = 8080\n`);

        const daemon = fixture.start([createLocalSocketComponent(), createNetworkListenerComponent()]);

        assert.equal(await daemon.exited, 1);
        const failure = fixture.lines.find((line) => line.includes("startup failed"));
        assert.ok(failure, "startup logs the failing step");
        assert.ok(failure.includes(`${UNOWNED_ADDRESS}:8080`), "the failure names the address and the port");
        assert.match(failure, /EADDRNOTAVAIL/);
        assert.equal(await exists(localSocketPath(fixture.env.runtimeDir)), false);
    });

    it("ends an instance feed stream stopped on the network listener and exits 0 when the daemon stops", {
        timeout: STOP_TEST_TIMEOUT_MS,
    }, async () => {
        const fixture = await createFixture();
        await fixture.configure(`[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
        const listener = createNetworkListenerComponent({ freePort: true });
        const daemon = fixture.start([listener]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const target = addressIn(listener);
        const stream = await open(target, "GET", "/feed?scope=instance");
        const streamBody = readAll(stream);
        await sleep(200);

        const stoppedAt = Date.now();
        const exitStatus = await daemon.stop();

        assert.equal(exitStatus, 0);
        assert.ok(Date.now() - stoppedAt <= STOP_BOUND_MS, "the daemon stopped within the stop bound");
        assert.match(await streamBody, /event: end\ndata: {"reason":"stopped"}\n\n$/);
        await assert.rejects(call(target, "POST", "/operations/daemon.status", {}));
    });

    it("starts the network listener on the same address after a role change and a restart", async () => {
        const fixture = await createFixture();
        await fixture.configure(`[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
        const agents = await createAgentsComponent({ logger: createLogger({ stream: { write: () => true } }) });
        const first = createNetworkListenerComponent({ freePort: true });
        const firstDaemon = fixture.start([agents.component, first], agents);
        await until(() => firstDaemon.phase() === "ready", "the first daemon to be ready");
        await firstDaemon.catalogue.invoke(
            "roles.create",
            { name: "reviewer", instructions: "Review the work.", tools: ["read"], skills: [] },
            caller,
        );
        await firstDaemon.catalogue.invoke("roles.change", { name: "reviewer", instructions: "Review hard." }, caller);
        assert.equal(await firstDaemon.stop(), 0);

        const secondAgents = await createAgentsComponent({ logger: createLogger({ stream: { write: () => true } }) });
        const second = createNetworkListenerComponent({ freePort: true });
        const secondDaemon = fixture.start([secondAgents.component, second], secondAgents);
        await until(() => secondDaemon.phase() === "ready", "the second daemon to be ready");

        const { host, port } = addressIn(second);
        assert.equal(host, LOOPBACK);
        assert.equal((await call({ host, port }, "POST", "/operations/daemon.status", {})).status, 200);
    });
});
