import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { type StartupReport, writeStartupReport } from "../../src/daemon/startup_report.ts";
import { runningVersions } from "../../src/host/versions.ts";
import { READY_WAIT_MS, readRunningVersion, waitForReady } from "../../src/install/ready_wait.ts";
import type { ServiceRecord } from "../../src/install/service_manager.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const SHORT_TIMEOUT_MS = scaled(500);
const READY_TIMEOUT_MS = scaled(30_000);
const LATE_START_DELAY_MS = scaled(300);

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

async function createWorld(): Promise<{ env: HermeticEnv; record: ServiceRecord; start(): RunningDaemon }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const record: ServiceRecord = {
        format: 1,
        platform: "linux-x64",
        label: "the-intern.test",
        configDir: env.configDir,
        stateDir: env.stateDir,
        dataDir: env.dataDir,
        runtimeDir: env.runtimeDir,
        piAgentDir: env.piAgentDir,
        path: env.env.PATH ?? "",
        lingerTurnedOn: false,
    };
    return {
        env,
        record,
        start() {
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: env.env,
                homeDir: env.root,
                logger: createLogger({ verbose: false, stream: { write: () => true } }),
                components: [createLocalSocketComponent()],
                prepareModels: () => modelsFor(fake),
            });
            daemons.push(daemon);
            return daemon;
        },
    };
}

const FAILED_REPORT: StartupReport = {
    format: 1,
    version: "0.0.1",
    pid: 1,
    serviceLabel: "the-intern.test",
    furthestStep: 4,
    failedStep: 4,
    failedStepName: "open database",
    reason: "broken",
    ready: false,
    noDefaultModel: false,
    ready: false,
};

describe("the ready wait", () => {
    it("waits 60 seconds by default", () => {
        assert.equal(READY_WAIT_MS, 60_000);
    });

    it("returns ready with the daemon's version when the daemon is ready", async () => {
        const world = await createWorld();
        world.start();

        const result = await waitForReady(world.record, { timeoutMs: READY_TIMEOUT_MS });

        assert.deepEqual(result, { ready: true, version: runningVersions().intern });
    });

    it("keeps trying while no daemon answers and returns ready once a daemon started late is ready", async () => {
        const world = await createWorld();
        const waiting = waitForReady(world.record, { timeoutMs: READY_TIMEOUT_MS });
        await new Promise((resolve) => setTimeout(resolve, LATE_START_DELAY_MS));
        world.start();

        assert.deepEqual(await waiting, { ready: true, version: runningVersions().intern });
    });

    it("keeps trying through failed probes and a daemon that is not ready yet", async () => {
        const world = await createWorld();
        const answers = [null, { phase: "starting", version: "1.0.0" }, null, { phase: "ready", version: "1.0.0" }];
        let calls = 0;

        const result = await waitForReady(world.record, {
            timeoutMs: READY_TIMEOUT_MS,
            probe: async () => answers[calls++] ?? null,
        });

        assert.deepEqual(result, { ready: true, version: "1.0.0" });
        assert.equal(calls, answers.length);
    });

    it("returns not ready at the timeout when a status call never answers", async () => {
        const world = await createWorld();
        await writeStartupReport(world.record.stateDir, FAILED_REPORT);
        const startedAt = Date.now();

        const result = await waitForReady(world.record, {
            timeoutMs: SHORT_TIMEOUT_MS,
            probe: () => new Promise(() => undefined),
        });

        assert.deepEqual(result, { ready: false, report: FAILED_REPORT });
        assert.ok(Date.now() - startedAt < SHORT_TIMEOUT_MS * 4, "the wait ended near its timeout");
    });

    it("returns not ready with the startup report the state directory holds when no daemon answers in time", async () => {
        const world = await createWorld();
        await writeStartupReport(world.record.stateDir, FAILED_REPORT);

        const result = await waitForReady(world.record, { timeoutMs: SHORT_TIMEOUT_MS });

        assert.deepEqual(result, { ready: false, report: FAILED_REPORT });
    });

    it("returns not ready with no report when the state directory holds none", async () => {
        const world = await createWorld();

        const result = await waitForReady(world.record, { timeoutMs: SHORT_TIMEOUT_MS });

        assert.deepEqual(result, { ready: false, report: undefined });
    });
});

describe("the running version", () => {
    it("is null when no daemon answers", async () => {
        const world = await createWorld();

        assert.equal(await readRunningVersion(world.record), null);
    });

    it("is the daemon's version when it answers", async () => {
        const world = await createWorld();
        world.start();
        await waitForReady(world.record, { timeoutMs: READY_TIMEOUT_MS });

        assert.equal(await readRunningVersion(world.record), runningVersions().intern);
    });
});
