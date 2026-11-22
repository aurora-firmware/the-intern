import assert from "node:assert/strict";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type DaemonComponent, type DaemonOptions, type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    readStartupReport,
    STARTUP_REPORT_FILE,
    type StartupReport,
    writeStartupReport,
} from "../../src/daemon/startup_report.ts";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import { runningVersions } from "../../src/host/versions.ts";
import { JOB_SCHEMA_VERSION } from "../../src/jobs/job_store.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_TIMEOUT_MS = scaled(10_000);
const POLL_INTERVAL_MS = 10;
const LOOPBACK = "127.0.0.1";
const LAST_STEP = 8;
const SERVICE_LABEL = "the-intern.test";

type FakeModel = ReturnType<typeof createFakeModel>;

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const close of closers.splice(0)) close();
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
    start(overrides?: Partial<DaemonOptions>, extraEnv?: NodeJS.ProcessEnv): RunningDaemon;
};

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const lines: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (chunk) => lines.push(String(chunk)) } });
    return {
        env,
        lines,
        start(overrides = {}, extraEnv = {}) {
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: { ...env.env, ...extraEnv },
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

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function reportOf(fixture: Fixture): Promise<StartupReport> {
    const report = await readStartupReport(fixture.env.stateDir);
    assert.ok(report, "the daemon wrote a startup report");
    return report;
}

function loggedCause(fixture: Fixture): string {
    const line = fixture.lines.find((candidate) => candidate.includes("startup failed"));
    assert.ok(line, "the daemon logged startup failed");
    const match = /cause="?(.*?)"?$/.exec(line.trim());
    assert.ok(match, `the line names a cause: ${line}`);
    return match[1] as string;
}

async function seedSchemas(fixture: Fixture, tables: string): Promise<void> {
    const database = await openHostDatabase(join(fixture.env.stateDir, "the-intern.sqlite"));
    await database.exec(tables);
    await database.close();
}

const NEWER_JOB_SCHEMA = (version: number) => `
    CREATE TABLE intern_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO intern_schema (id, version) VALUES (1, ${version});`;

const NEWER_DURABLE_SCHEMA = (version: number) => `
    CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
    INSERT INTO durable_schema (singleton, version) VALUES (1, ${version});`;

describe("the daemon's startup report", () => {
    it("holds the version, pid, label, furthest step 8 and ready, owner-only, once the daemon is ready", async () => {
        const fixture = await createFixture();

        const daemon = fixture.start({}, { BOB_SERVICE_LABEL: SERVICE_LABEL });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        const report = await reportOf(fixture);
        assert.deepEqual(report, {
            format: 1,
            version: runningVersions().intern,
            pid: process.pid,
            serviceLabel: SERVICE_LABEL,
            furthestStep: LAST_STEP,
            failedStep: null,
            failedStepName: null,
            reason: null,
            unreadableDatabase: false,
            ready: true,
        });
        const info = await stat(join(fixture.env.stateDir, STARTUP_REPORT_FILE));
        assert.equal(info.mode & 0o777, 0o600);
    });

    it("holds a null label when the environment names no service", async () => {
        const fixture = await createFixture();

        const daemon = fixture.start();
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        assert.equal((await reportOf(fixture)).serviceLabel, null);
    });

    it("keeps the larger furthest step of a file left by an earlier start", async () => {
        const fixture = await createFixture();
        await writeStartupReport(fixture.env.stateDir, {
            format: 1,
            version: "0.0.1",
            pid: 1,
            serviceLabel: null,
            furthestStep: LAST_STEP,
            failedStep: 8,
            failedStepName: "start components",
            reason: "old",
            unreadableDatabase: false,
            ready: false,
        });
        await writeFile(join(fixture.env.configDir, "config.toml"), "not = = toml");

        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);
        const report = await reportOf(fixture);
        assert.equal(report.furthestStep, LAST_STEP);
        assert.equal(report.failedStep, 1);
    });

    it("names step 1, its name and the logged reason when the configuration file is invalid", async () => {
        const fixture = await createFixture();
        await writeFile(join(fixture.env.configDir, "config.toml"), "not = = toml");

        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);
        const report = await reportOf(fixture);
        assert.equal(report.failedStep, 1);
        assert.equal(report.failedStepName, "load configuration");
        assert.equal(report.furthestStep, 1);
        assert.equal(report.ready, false);
        assert.equal(report.unreadableDatabase, false);
        assert.ok(report.reason?.includes("config.toml"));
        // The log writes a newline as `\\n`, so the first line of the reason is the part that compares.
        assert.ok(loggedCause(fixture).startsWith(report.reason?.split("\n")[0] ?? ""));
    });

    it("writes no report while the state directory is open to others", async () => {
        const fixture = await createFixture();
        await chmod(fixture.env.stateDir, 0o750);
        await writeFile(join(fixture.env.configDir, "config.toml"), "not = = toml");

        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);
        assert.equal(await readStartupReport(fixture.env.stateDir), undefined);
    });

    it("writes no report while the state directory is missing, and still fails at step 1", async () => {
        const fixture = await createFixture();
        await rm(fixture.env.stateDir, { recursive: true });
        await writeFile(join(fixture.env.configDir, "config.toml"), "not = = toml");

        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);
        assert.ok(fixture.lines.some((line) => line.includes("step=1")));
        assert.equal(await readStartupReport(fixture.env.stateDir).catch(() => "unreadable"), undefined);
    });

    it("marks the database unreadable when its job schema is newer than the release's", async () => {
        const fixture = await createFixture();
        await seedSchemas(fixture, NEWER_JOB_SCHEMA(JOB_SCHEMA_VERSION + 1));

        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);
        const report = await reportOf(fixture);
        assert.equal(report.failedStep, 4);
        assert.equal(report.failedStepName, "create model runtime");
        assert.equal(report.furthestStep, 4);
        assert.equal(report.unreadableDatabase, true);
        assert.equal(report.ready, false);
        assert.equal(report.reason, loggedCause(fixture));
    });

    it("marks the database unreadable when its pi-durable data is newer than the release's", async () => {
        const fixture = await createFixture();
        await seedSchemas(fixture, NEWER_DURABLE_SCHEMA(9999));

        const daemon = fixture.start();

        assert.equal(await daemon.exited, 1);
        const report = await reportOf(fixture);
        assert.equal(report.failedStep, 4);
        assert.equal(report.unreadableDatabase, true);
    });

    it("reports furthest step 8 with a readable database when the web port is taken", async () => {
        const fixture = await createFixture();
        const occupier = createServer();
        await new Promise<void>((resolve) => occupier.listen(0, LOOPBACK, resolve));
        closers.push(() => occupier.close());
        const address = occupier.address();
        assert.ok(address && typeof address === "object");
        await writeFile(
            join(fixture.env.configDir, "config.toml"),
            `[network]\naddress = "${LOOPBACK}"\nport = ${address.port}\n`,
        );
        const listener: DaemonComponent = createNetworkListenerComponent();

        const daemon = fixture.start({ sections: [networkSection], components: [listener] });

        assert.equal(await daemon.exited, 1);
        const report = await reportOf(fixture);
        assert.equal(report.failedStep, LAST_STEP);
        assert.equal(report.failedStepName, "start components");
        assert.equal(report.furthestStep, LAST_STEP);
        assert.equal(report.unreadableDatabase, false);
        assert.equal(report.ready, false);
        assert.equal(report.reason, loggedCause(fixture));
    });
});
