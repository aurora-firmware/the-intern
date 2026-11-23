import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scaled } from "../support/time_scale.ts";
import {
    cleanUpInstall,
    createJob,
    fileMode,
    installedBob,
    type JobView,
    listJobs,
    locationDir,
    type RunResult,
    runAs,
    runInstallScript,
    type ServiceStatus,
    startFakeModelServer,
    waitUntil,
    writePiAgentDir,
} from "./cycle_support.ts";
import { defaultScript, type FakeModelServer } from "./fake_model_server.ts";

const FIRST_VERSION = "0.1.0";
const SECOND_VERSION = "0.2.0";
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const JOB_COUNT = 3;
const STOP_WAIT_MS = scaled(60_000);
const CONFIG_TEXT = "# A configuration file with no setting: every one keeps its default.\n";
const DATABASE_FILE = "the-intern.sqlite";
const COPY_DATABASE_FILE = "database.sqlite";

/** The names of the steps of an upgrade and of a rollback, as `UPGRADE_STEPS` and `ROLLBACK_STEPS` list them. */
const UPGRADE_STEP_NAMES = ["held", "stopped", "owned", "copied", "switched", "released", "ready"];
const ROLLBACK_STEP_NAMES = [
    "held",
    "stopped",
    "owned",
    "set-aside",
    "switched",
    "imported",
    "restored",
    "released",
    "ready",
];

const root = join(homedir(), "cut-off-test");
const piAgentDir = join(root, "pi-agent");
const scratchDir = join(root, "scratch");
const programRoot = join(homedir(), ".local", "lib", "the-intern");
const configDir = join(homedir(), ".config", "the-intern");
const configFile = join(configDir, "config.toml");

const outputOf = (result: RunResult): string => `${result.stdout}${result.stderr}`;

type DaemonStatus = { phase: string; versions: { intern: string } };
type JobKey = Pick<JobView, "id" | "number" | "title">;
type Instance = { server: FakeModelServer; stateDir: string; jobs: JobKey[] };

async function checkedStdout(args: readonly string[]): Promise<string> {
    const result = await runAs(installedBob(), args);
    assert.equal(result.status, 0, outputOf(result));
    return result.stdout;
}

async function serviceStatus(): Promise<ServiceStatus> {
    return JSON.parse(await checkedStdout(["service", "status", "--json"])) as ServiceStatus;
}

async function daemonStatus(): Promise<DaemonStatus> {
    return JSON.parse(await checkedStdout(["status", "--json"])) as DaemonStatus;
}

/** The version a link of the program folder names, or null when the link doesn't exist. */
function linkedVersion(name: "current" | "previous"): string | null {
    try {
        return basename(readlinkSync(join(programRoot, name)));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

/** The jobs as the instance lists them, without their status, which changes as a job runs. */
async function jobKeys(): Promise<JobKey[]> {
    const jobs = await listJobs();
    return jobs.map(({ id, number, title }) => ({ id, number, title })).sort((a, b) => a.id.localeCompare(b.id));
}

async function assertReadyWith(version: string, jobs: readonly JobKey[]): Promise<void> {
    assert.equal(linkedVersion("current"), version);
    const status = await daemonStatus();
    assert.equal(status.versions.intern, version);
    assert.equal(status.phase, "ready");
    const service = await serviceStatus();
    assert.equal(service.running, true);
    assert.equal(service.version, version);
    assert.deepEqual(await jobKeys(), jobs);
}

/** Installs 0.1.0 with its service on the fake model, and has `JOB_COUNT` jobs done on it. */
async function startInstance(): Promise<Instance> {
    await cleanUpInstall([root]);
    const installed = await runInstallScript("base", ["--version", FIRST_VERSION]);
    assert.equal(installed.status, 0, outputOf(installed));
    const server = await startFakeModelServer(defaultScript);
    await mkdir(configDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(configFile, CONFIG_TEXT, { mode: OWNER_ONLY_FILE_MODE });
    await writePiAgentDir(piAgentDir, server.baseUrl);
    const service = await runAs(installedBob(), ["service", "install"], { env: { PI_CODING_AGENT_DIR: piAgentDir } });
    assert.equal(service.status, 0, outputOf(service));
    for (let number = 1; number <= JOB_COUNT; number += 1) await createJob(`Answer question ${number}`);
    await waitUntil(
        "every job done",
        async () => (await listJobs()).map((job) => job.status),
        (statuses) => statuses.length === JOB_COUNT && statuses.every((status) => status === "done"),
    );
    const stateDir = (await serviceStatus()).stateDir ?? "";
    return { server, stateDir, jobs: await jobKeys() };
}

/** The environment of a command that downloads from the base location, with the user manager's bus. */
function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: homedir(),
        BOB_RELEASE_URL: locationDir("base"),
        ...extra,
    };
    for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    return env;
}

const withBase = (): { env: Record<string, string> } => ({ env: { BOB_RELEASE_URL: locationDir("base") } });

/** Runs `bob <args>` with the test hook that stops it after `step`, and kills it with `kill -9` once it has stopped. */
async function runCutOffAfter(args: readonly string[], step: string): Promise<void> {
    const child = spawn(installedBob(), args, {
        env: commandEnv({ BOB_INSTALL_TEST_STOP_AFTER: step }),
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    const ended = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
        await waitUntil(
            `${args[0]} stopping after ${step}`,
            async () => stderr,
            (seen) => seen.includes(`stopped after ${step}`),
            STOP_WAIT_MS,
        );
    } catch (error) {
        child.kill("SIGKILL");
        throw new Error(`${error instanceof Error ? error.message : error}; it ended with: ${stderr}`);
    }
    child.kill("SIGKILL");
    await ended;
}

/** The job ids a database file holds, read with the node of the bundle of 0.1.0. */
async function jobIdsIn(databaseFile: string): Promise<string[]> {
    const script = [
        'const { DatabaseSync } = require("node:sqlite");',
        "const database = new DatabaseSync(process.argv[1], { readOnly: true });",
        'console.log(JSON.stringify(database.prepare("SELECT id FROM intern_jobs").all().map((row) => row.id)));',
    ].join(" ");
    const node = join(programRoot, "versions", FIRST_VERSION, "node", "bin", "node");
    const result = await runAs(node, ["-e", script, databaseFile]);
    assert.equal(result.status, 0, outputOf(result));
    return JSON.parse(result.stdout) as string[];
}

/** The job ids of the copy of the upgrade, read by importing its database into a scratch state directory. */
async function jobIdsInCopy(stateDir: string): Promise<string[]> {
    const upgrades = join(stateDir, "upgrades");
    const copies = existsSync(upgrades)
        ? readdirSync(upgrades).filter((name) => existsSync(join(upgrades, name, COPY_DATABASE_FILE)))
        : [];
    assert.equal(copies.length, 1, `the upgrades folder holds the copies ${JSON.stringify(copies)}`);
    const scratch = {
        state: join(scratchDir, "state"),
        config: join(scratchDir, "config"),
        data: join(scratchDir, "data"),
    };
    for (const dir of Object.values(scratch)) await mkdir(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const bob = join(programRoot, "versions", FIRST_VERSION, "bin", "bob");
    const dirs = ["--state-dir", scratch.state, "--config-dir", scratch.config, "--data-dir", scratch.data];
    const database = join(upgrades, copies[0] ?? "", COPY_DATABASE_FILE);
    const imported = await runAs(bob, ["import", ...dirs, "--runtime-dir", join(scratchDir, "runtime"), database]);
    assert.equal(imported.status, 0, outputOf(imported));
    return jobIdsIn(join(scratch.state, DATABASE_FILE));
}

/** The ids of `jobs` that are in neither the database nor, when it is set aside, the copy. */
async function jobsMissing(stateDir: string, jobs: readonly JobKey[]): Promise<string[]> {
    const database = join(stateDir, DATABASE_FILE);
    const inDatabase = existsSync(database) ? await jobIdsIn(database) : [];
    const absent = jobs.map((job) => job.id).filter((id) => !inDatabase.includes(id));
    if (absent.length === 0) return [];
    const inCopy = await jobIdsInCopy(stateDir);
    return absent.filter((id) => !inCopy.includes(id));
}

type CutOffState = { current: string; shown: string; runs: string; missing: string[] };

/** What a cut-off leaves: the version `bob service status` names as current, whether its `bin/bob` runs and names it, the jobs lost. */
async function observeCutOff(instance: Instance): Promise<CutOffState> {
    const shown = await checkedStdout(["service", "status"]);
    const current = /^Current version: (\S+)$/m.exec(shown)?.[1] ?? "";
    const bob = join(programRoot, "versions", current, "bin", "bob");
    const ran = await runAs(bob, ["service", "status"]);
    const runs = ran.status === 0 ? (/^Current version: (\S+)$/m.exec(ran.stdout)?.[1] ?? "") : outputOf(ran);
    return { current, shown, runs, missing: await jobsMissing(instance.stateDir, instance.jobs) };
}

type Cycle = { instance: Instance; cutOff: CutOffState; repeated: RunResult };

/** Cuts the operation off after `step`, looks at what it left, then runs the same command again. */
async function cutOffAndRepeat(
    instance: Instance,
    args: readonly string[],
    step: string,
    expectedVersion: string,
): Promise<Cycle> {
    await runCutOffAfter(args, step);
    const cutOff = await observeCutOff(instance);
    const repeated = await runAs(installedBob(), args, withBase());
    assert.equal(repeated.status, 0, outputOf(repeated));
    await assertReadyWith(expectedVersion, instance.jobs);
    return { instance, cutOff, repeated };
}

const upgradeArgs = ["upgrade", SECOND_VERSION, "--yes"];
const rollbackArgs = ["rollback", "--yes"];

async function upgradeToSecond(): Promise<void> {
    const upgraded = await runAs(installedBob(), upgradeArgs, withBase());
    assert.equal(upgraded.status, 0, outputOf(upgraded));
}

function describeCutOffs(
    operation: string,
    steps: readonly string[],
    prepare: () => Promise<void>,
    args: readonly string[],
    expectedVersion: string,
): void {
    for (const step of steps) {
        describe(`bob ${args.join(" ")} cut off with kill -9 after ${step}`, () => {
            let cycle: Cycle;

            before(async () => {
                const instance = await startInstance();
                cycle = {
                    instance,
                    cutOff: { current: "", shown: "", runs: "", missing: [] },
                    repeated: null as never,
                };
                await prepare();
                cycle = await cutOffAndRepeat(instance, args, step, expectedVersion);
            });

            after(async () => {
                await cycle?.instance.server.close();
                await cleanUpInstall([root]);
            });

            test(`bob service status names one complete current version that bin/bob runs, after the ${operation}`, () => {
                const { current, shown, runs } = cycle.cutOff;
                assert.ok([FIRST_VERSION, SECOND_VERSION].includes(current), shown);
                assert.equal(runs, current, `bin/bob of ${current} did not run and name it: ${runs}`);
            });

            test("every job exists in the database or in the copy", () => {
                assert.deepEqual(cycle.cutOff.missing, []);
            });

            test(`the same command again finishes it with ${expectedVersion} ready`, () => {
                assert.equal(cycle.repeated.status, 0, outputOf(cycle.repeated));
            });
        });
    }
}

describeCutOffs("upgrade", UPGRADE_STEP_NAMES, async () => {}, upgradeArgs, SECOND_VERSION);
describeCutOffs("rollback", ROLLBACK_STEP_NAMES, upgradeToSecond, rollbackArgs, FIRST_VERSION);

/** Asserts that `folder` and everything in it is closed to the group and to others, and the folder itself is 0700. */
function assertOwnerOnly(folder: string): void {
    assert.equal(fileMode(folder), OWNER_ONLY_DIR_MODE, `${folder} is not 0700`);
    for (const entry of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
        const mode = fileMode(join(folder, entry));
        assert.equal(mode & GROUP_AND_OTHER_BITS, 0, `${join(folder, entry)} has mode ${mode.toString(8)}`);
    }
}

describe("the upgrades folder after an upgrade and a rollback that set a database aside", () => {
    let instance: Instance;

    before(async () => {
        instance = await startInstance();
        await upgradeToSecond();
        const rolledBack = await runAs(installedBob(), rollbackArgs);
        assert.equal(rolledBack.status, 0, outputOf(rolledBack));
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it holds the copy and the set-aside database, and all of it is accessible to the owner only", () => {
        const upgrades = join(instance.stateDir, "upgrades");
        const names = readdirSync(upgrades);
        assert.ok(
            names.some((name) => name.endsWith(`-${SECOND_VERSION}-rollback`)),
            `no database was set aside: ${names.join(",")}`,
        );
        assert.ok(names.some((name) => name.endsWith(`-${FIRST_VERSION}-to-${SECOND_VERSION}`)));
        assertOwnerOnly(upgrades);
    });
});
