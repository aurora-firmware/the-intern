import assert from "node:assert/strict";
import { access, chmod, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { WORKER_THREAD_COUNT } from "../../src/daemon/constants.ts";
import {
    type DaemonComponent,
    type DaemonOptions,
    type RunningDaemon,
    runDaemon,
    type ServiceContext,
} from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { openHarnessHost } from "../../src/host/harness_host.ts";
import { recordOpenedVersions, runningVersions } from "../../src/host/versions.ts";
import { ServiceError } from "../../src/service/operations.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const TEAM_MEMBER = { actor: { kind: "team_member" } } as const;
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const RUN_DELAY_MS = 400;

type FakeModel = ReturnType<typeof createFakeModel>;

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

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
    start(overrides?: Partial<DaemonOptions>): RunningDaemon;
};

async function createFixture(delayMs = 0): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => delayMs });
    fakes.push(fake);
    const lines: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (chunk) => lines.push(String(chunk)) } });
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    return {
        env,
        lines,
        modelId,
        start(overrides = {}) {
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
                prepareModels: () => modelsFor(fake),
                ...overrides,
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
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function status(daemon: RunningDaemon): Promise<DaemonStatus> {
    return (await daemon.catalogue.invoke("daemon.status", {}, TEAM_MEMBER)) as DaemonStatus;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function linesMatching(lines: string[], text: string): string[] {
    return lines.filter((line) => line.includes(text));
}

describe("runDaemon startup", () => {
    it("runs the eight startup steps in order and reports starting until the start hooks have finished", async () => {
        const fixture = await createFixture();
        const calls: string[] = [];
        const phasesSeen: string[] = [];
        let daemon: RunningDaemon | undefined;
        const component: DaemonComponent = {
            name: "recorder",
            async checkModels() {
                calls.push("checkModels");
            },
            async ensureWorkspaces() {
                calls.push("ensureWorkspaces");
            },
            async start() {
                calls.push("start");
                if (daemon) phasesSeen.push((await status(daemon)).phase);
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (daemon) phasesSeen.push((await status(daemon)).phase);
            },
        };
        daemon = fixture.start({ components: [component] });

        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.deepEqual(calls, ["checkModels", "ensureWorkspaces", "start"]);
        assert.deepEqual(phasesSeen, ["starting", "starting"]);
        const stepLines = linesMatching(fixture.lines, "startup step").map((line) => /step=(\d)/.exec(line)?.[1]);
        assert.deepEqual(stepLines, ["1", "2", "3", "4", "5", "6", "7", "8"]);
        assert.equal((await status(daemon)).phase, "ready");
    });

    it("rejects every operation other than daemon.status with unavailable while starting", async () => {
        const fixture = await createFixture();
        let daemon: RunningDaemon | undefined;
        const rejections: unknown[] = [];
        const component: DaemonComponent = {
            name: "probe",
            async start() {
                for (const { name } of daemon?.catalogue.list() ?? []) {
                    if (name === "daemon.status") continue;
                    await daemon?.catalogue.invoke(name, {}, TEAM_MEMBER).catch((error: unknown) => {
                        rejections.push(error);
                    });
                }
            },
        };
        daemon = fixture.start({ components: [component] });

        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.ok(rejections.length > 10, "every other operation was probed");
        for (const error of rejections) {
            assert.ok(error instanceof ServiceError);
            assert.equal(error.code, "unavailable");
        }
    });

    it("logs one ready line naming the state directory, the versions and the worker-thread count", async () => {
        const fixture = await createFixture();
        const daemon = fixture.start();

        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        const versions = runningVersions();
        const ready = linesMatching(fixture.lines, "INFO ready");
        assert.equal(ready.length, 1);
        assert.match(ready[0], new RegExp(`stateDir=${fixture.env.stateDir}`));
        assert.match(ready[0], new RegExp(`intern=${versions.intern}`));
        assert.match(ready[0], new RegExp(`pi=${versions.pi.replaceAll(".", "\\.")}`));
        assert.match(ready[0], new RegExp(`workerThreads=${WORKER_THREAD_COUNT}`));
        assert.equal((await status(daemon)).workerThreads.count, WORKER_THREAD_COUNT);
    });

    it("gates model requests by the worker-thread count", async () => {
        const fixture = await createFixture(RUN_DELAY_MS);
        let context: ServiceContext | undefined;
        const component: DaemonComponent = {
            name: "capture",
            async start(ctx) {
                context = ctx;
            },
        };
        const daemon = fixture.start({ components: [component], workerThreadCount: 1 });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        for (const requestId of ["first", "second"]) {
            const conversationId = await context?.host.createConversation({ agent: { model: fixture.modelId } });
            await daemon.catalogue.invoke(
                "conversations.submit",
                { conversationId, content: "hello", requestId },
                TEAM_MEMBER,
            );
        }

        await until(async () => (await status(daemon)).workerThreads.waiting.length === 1, "one run to wait");
        assert.equal((await status(daemon)).workerThreads.inUse, 1);
    });

    it("logs the change and reaches ready when the recorded versions differ from the running ones", async () => {
        const fixture = await createFixture();
        const seeding = await openHarnessHost({
            databaseFile: join(fixture.env.stateDir, "the-intern.sqlite"),
            models: modelsFor(fakes[0]),
            harnessSettings: {},
            extensions: [],
            defaultCwd: process.cwd(),
            logger: createLogger({ stream: { write: () => true } }),
        });
        await recordOpenedVersions(seeding, { intern: "0.0.0-old", pi: "0.0.0-old" });
        await seeding.close();

        const daemon = fixture.start();
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        const changes = linesMatching(fixture.lines, "INFO versions changed");
        assert.equal(changes.length, 1);
        assert.match(changes[0], /previousIntern=0\.0\.0-old/);
        assert.match(changes[0], new RegExp(`intern=${runningVersions().intern.replaceAll(".", "\\.")}`));
    });

    it("does not log a version change on a first start", async () => {
        const fixture = await createFixture();
        const daemon = fixture.start();

        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.equal(linesMatching(fixture.lines, "versions changed").length, 0);
    });
});

describe("runDaemon startup failures", () => {
    it("names step 1 and creates no database file when the configuration is invalid", async () => {
        const fixture = await createFixture();
        await writeFile(join(fixture.env.configDir, "config.toml"), "unknown = 1\n");
        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);

        const failure = linesMatching(fixture.lines, "ERROR");
        assert.equal(failure.length, 1);
        assert.match(failure[0], /step=1/);
        assert.match(failure[0], /load configuration/);
        assert.match(failure[0], /no configuration section owns this key/);
        assert.deepEqual(await readdir(fixture.env.stateDir), []);
    });

    it("names step 2 and creates no database file when a directory is unsafe", async () => {
        const fixture = await createFixture();
        await chmod(fixture.env.dataDir, 0o755);
        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);

        const failure = linesMatching(fixture.lines, "ERROR");
        assert.equal(failure.length, 1);
        assert.match(failure[0], /step=2/);
        assert.match(failure[0], /accessible to the group or others/);
        assert.equal(await exists(join(fixture.env.stateDir, "the-intern.sqlite")), false);
    });

    it("names step 2 when a directory flag is not an absolute path", async () => {
        const fixture = await createFixture();
        const daemon = fixture.start({ flags: { stateDir: "relative/state" } });

        assert.equal(await daemon.exited, 1);

        const failure = linesMatching(fixture.lines, "ERROR");
        assert.equal(failure.length, 1);
        assert.match(failure[0], /step=2/);
        assert.match(failure[0], /must be an absolute path/);
    });

    it("names step 3 and the owner when a live daemon owns the state directory", async () => {
        const fixture = await createFixture();
        const first = fixture.start();
        await until(() => first.phase() === "ready", "the first daemon to be ready");
        fixture.lines.length = 0;

        const second = fixture.start();

        assert.equal(await second.exited, 1);
        const failure = linesMatching(fixture.lines, "ERROR");
        assert.equal(failure.length, 1);
        assert.match(failure[0], /step=3/);
        assert.match(failure[0], new RegExp(`pid ${process.pid}`));
    });

    it("names step 5, releases ownership and settles with 1 when a model check fails", async () => {
        const fixture = await createFixture();
        const component: DaemonComponent = {
            name: "models",
            async checkModels() {
                throw new Error('Model "x/y" is not in the model registry');
            },
        };
        const daemon = fixture.start({ components: [component] });

        assert.equal(await daemon.exited, 1);

        const failure = linesMatching(fixture.lines, "ERROR");
        assert.equal(failure.length, 1);
        assert.match(failure[0], /step=5/);
        assert.match(failure[0], /check models/);
        assert.match(failure[0], /not in the model registry/);
        assert.equal(await exists(join(fixture.env.stateDir, "owner.lock")), false);
        assert.equal(daemon.phase(), "stopping");
    });

    it("stops the components already started when a later start hook fails", async () => {
        const fixture = await createFixture();
        const stopped: string[] = [];
        const components: DaemonComponent[] = [
            {
                name: "first",
                async start() {},
                async stop() {
                    stopped.push("first");
                },
            },
            {
                name: "second",
                async start() {
                    throw new Error("listener could not bind");
                },
                async stop() {
                    stopped.push("second");
                },
            },
        ];
        const daemon = fixture.start({ components });

        assert.equal(await daemon.exited, 1);

        assert.match(linesMatching(fixture.lines, "ERROR")[0], /step=8/);
        assert.deepEqual(stopped, ["first"]);
        assert.equal(await exists(join(fixture.env.stateDir, "owner.lock")), false);
    });
});
