import assert from "node:assert/strict";
import fsPromises, { access, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, request, Server } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it, mock } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { LOCAL_SOCKET_FILE, localSocketPath, MAX_SOCKET_PATH_BYTES } from "../../src/listeners/socket_path.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const RUN_DELAY_MS = 60_000;
const WAIT_CALL_TIMEOUT_MS = 300_000;
const PERMISSION_BITS = 0o777;
const OWNER_ONLY_FILE_MODE = 0o600;
const STOP_TEST_TIMEOUT_MS = STOP_BOUND_MS + 10_000;

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

type Fixture = {
    env: HermeticEnv;
    lines: string[];
    modelId: string;
    start(components: readonly DaemonComponent[], runtimeDir?: string): RunningDaemon;
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
        start(components, runtimeDir = env.runtimeDir) {
            const daemon = runDaemon({
                flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir },
                env: env.env,
                homeDir: env.root,
                logger,
                prepareModels: () => modelsFor(fake),
                components,
            });
            daemons.push(daemon);
            return daemon;
        },
    };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
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
    socketPath: string,
    method: string,
    target: string,
    body?: unknown,
): { response: Promise<IncomingMessage>; abort(): void } {
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    const call = request({ socketPath, method, path: target, headers });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
        call.once("response", resolve);
        call.once("error", reject);
    });
    call.end(body === undefined ? undefined : JSON.stringify(body));
    return { response, abort: () => call.destroy() };
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

async function call(socketPath: string, method: string, target: string, body?: unknown): Promise<Answer> {
    const response = await open(socketPath, method, target, body).response;
    return { status: response.statusCode ?? 0, body: await readAll(response) };
}

function capturingComponent(): { component: DaemonComponent; context: () => ServiceContext } {
    let captured: ServiceContext | undefined;
    return {
        component: {
            name: "capture",
            async start(ctx) {
                captured = ctx;
            },
        },
        context() {
            assert.ok(captured, "the capture component has started");
            return captured;
        },
    };
}

describe("local socket listener", () => {
    it("answers daemon.status on bob.sock, a file only the service account can use", async () => {
        const fixture = await createFixture();
        const daemon = fixture.start([createLocalSocketComponent()]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const socketPath = localSocketPath(fixture.env.runtimeDir);

        const answer = await call(socketPath, "POST", "/operations/daemon.status", {});

        assert.equal(socketPath, join(fixture.env.runtimeDir, LOCAL_SOCKET_FILE));
        assert.equal(answer.status, 200);
        assert.equal(JSON.parse(answer.body).result.phase, "ready");
        assert.equal((await stat(socketPath)).mode & PERMISSION_BITS, OWNER_ONLY_FILE_MODE);
    });

    it("replaces a leftover bob.sock and becomes ready", async () => {
        const fixture = await createFixture();
        const socketPath = localSocketPath(fixture.env.runtimeDir);
        await writeFile(socketPath, "left behind by a killed daemon");

        const daemon = fixture.start([createLocalSocketComponent()]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.equal((await call(socketPath, "POST", "/operations/daemon.status", {})).status, 200);
    });

    it("replaces a leftover bob.sock that an earlier listener left bound", async () => {
        const fixture = await createFixture();
        const socketPath = localSocketPath(fixture.env.runtimeDir);
        const leftover = createServer();
        await new Promise<void>((resolve) => leftover.listen(socketPath, resolve));
        leftover.unref();

        const daemon = fixture.start([createLocalSocketComponent()]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.equal((await call(socketPath, "POST", "/operations/daemon.status", {})).status, 200);
        leftover.close();
    });

    it("fails startup in step 8 naming the path when the socket path is longer than the platform limit", async () => {
        const fixture = await createFixture();
        const longDirectory = join(fixture.env.runtimeDir, "d".repeat(MAX_SOCKET_PATH_BYTES));
        const socketPath = localSocketPath(longDirectory);

        const daemon = fixture.start([createLocalSocketComponent()], longDirectory);

        assert.equal(await daemon.exited, 1);
        const failure = fixture.lines.find((line) => line.includes("startup failed"));
        assert.ok(failure, "startup logs the failing step");
        assert.match(failure, /step=8 name="start components"/);
        assert.ok(failure.includes(socketPath), `the failure names ${socketPath}`);
    });

    it("closes the listener and removes bob.sock when startup fails after the listener is up", async () => {
        const fixture = await createFixture();
        const socketPath = localSocketPath(fixture.env.runtimeDir);
        // Only the socket file's chmod fails: the daemon's own directory setup uses chmod too.
        const chmod = fsPromises.chmod;
        mock.method(fsPromises, "chmod", async (path: string, mode: number) => {
            if (path === socketPath) throw new Error("chmod refused");
            return chmod(path, mode);
        });
        syncBuiltinESMExports();

        const servers: Server[] = [];
        const listen = Server.prototype.listen;
        mock.method(Server.prototype, "listen", function (this: Server, ...args: Parameters<Server["listen"]>) {
            servers.push(this);
            return listen.apply(this, args);
        });

        const daemon = fixture.start([createLocalSocketComponent()]);

        assert.equal(await daemon.exited, 1);
        assert.ok(fixture.lines.some((line) => line.includes("chmod refused")));
        assert.equal(await exists(socketPath), false);
        await assert.rejects(call(socketPath, "POST", "/operations/daemon.status", {}));
        assert.equal(servers.length, 1);
        assert.equal(servers[0]?.listening, false, "the listener stays open");
    });

    it("answers daemon.status starting and refuses other calls and the feed while a later start hook is held", async () => {
        const fixture = await createFixture();
        const hookEntered = Promise.withResolvers<void>();
        const hookRelease = Promise.withResolvers<void>();
        const held: DaemonComponent = {
            name: "held",
            async start() {
                hookEntered.resolve();
                await hookRelease.promise;
            },
        };
        const daemon = fixture.start([createLocalSocketComponent(), held]);
        await hookEntered.promise;
        const socketPath = localSocketPath(fixture.env.runtimeDir);

        const status = await call(socketPath, "POST", "/operations/daemon.status", {});
        const other = await call(socketPath, "POST", "/operations/conversations.list", {});
        const feed = await call(socketPath, "GET", "/feed?scope=instance");

        assert.equal(status.status, 200);
        assert.equal(JSON.parse(status.body).result.phase, "starting");
        assert.equal(other.status, 503);
        assert.equal(JSON.parse(other.body).error.code, "unavailable");
        assert.equal(feed.status, 503);
        assert.equal(JSON.parse(feed.body).error.code, "unavailable");
        hookRelease.resolve();
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
    });

    it("ends a feed stream stopped, ends a submissions.wait, removes bob.sock and exits 0 when the daemon stops", {
        timeout: STOP_TEST_TIMEOUT_MS,
    }, async () => {
        const fixture = await createFixture();
        const capture = capturingComponent();
        const daemon = fixture.start([createLocalSocketComponent(), capture.component]);
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const socketPath = localSocketPath(fixture.env.runtimeDir);
        const { host } = capture.context();
        const conversationId = await host.createConversation({ agent: { model: fixture.modelId } });
        const submitted = await call(socketPath, "POST", "/operations/conversations.submit", {
            conversationId,
            content: "hello",
            requestId: "request-1",
        });
        const { submissionId } = JSON.parse(submitted.body).result;
        const stream = await open(socketPath, "GET", "/feed?scope=instance").response;
        const streamBody = readAll(stream);
        const wait = open(socketPath, "POST", "/operations/submissions.wait", {
            submissionId,
            timeoutMs: WAIT_CALL_TIMEOUT_MS,
        });
        const waitOutcome = wait.response.then(
            async (response) => ({ status: response.statusCode, body: await readAll(response) }),
            () => ({ status: "closed" as const, body: "" }),
        );
        await sleep(200);

        const stoppedAt = Date.now();
        const exitStatus = await daemon.stop();

        assert.equal(exitStatus, 0);
        assert.ok(Date.now() - stoppedAt <= STOP_BOUND_MS, "the daemon stopped within the stop bound");
        assert.match(await streamBody, /event: end\ndata: {"reason":"stopped"}\n\n$/);
        const outcome = await waitOutcome;
        assert.ok(outcome.status === 503 || outcome.status === "closed", `wait ended with ${outcome.status}`);
        assert.equal(await exists(socketPath), false);
    });
});
