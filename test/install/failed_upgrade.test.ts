import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
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
const REFUSED = 1;
const LOOPBACK = "127.0.0.1";
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const JOB_COUNT = 3;
const STOP_WAIT_MS = scaled(60_000);
const STOP_POLL_MS = 100;
const PLANTED_SECRET = "planted-secret-value";
const DATABASE_FILE = "the-intern.sqlite";
const CONFIG_TEXT = "# A configuration file with no setting: every one keeps its default.\n";
const ASK_SWITCH_BACK = "Switch back to 0.1.0?";

const root = join(homedir(), "failed-upgrade-test");
const piAgentDir = join(root, "pi-agent");
const programRoot = join(homedir(), ".local", "lib", "the-intern");
const configDir = join(homedir(), ".config", "the-intern");
const configFile = join(configDir, "config.toml");

const outputOf = (result: RunResult): string => `${result.stdout}${result.stderr}`;

type DaemonStatus = { phase: string; versions: { intern: string } };
type JobKey = Pick<JobView, "id" | "number" | "title">;

async function checkedStatus(args: readonly string[]): Promise<string> {
    const result = await runAs(installedBob(), args);
    assert.equal(result.status, 0, outputOf(result));
    return result.stdout;
}

async function serviceStatus(): Promise<ServiceStatus> {
    return JSON.parse(await checkedStatus(["service", "status", "--json"])) as ServiceStatus;
}

async function daemonStatus(): Promise<DaemonStatus> {
    return JSON.parse(await checkedStatus(["status", "--json"])) as DaemonStatus;
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

const installedVersions = (): string[] => readdirSync(join(programRoot, "versions")).sort();

/** The jobs as the instance lists them, without their status, which changes as a job runs. */
async function jobKeys(): Promise<JobKey[]> {
    const jobs = await listJobs();
    return jobs.map(({ id, number, title }) => ({ id, number, title })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Asserts that `version` is current and its daemon ready, with `jobs` listed. */
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

function upgradesFolder(stateDir: string): string {
    return join(stateDir, "upgrades");
}

/** The names in the upgrades folder, sorted. */
function upgradeNames(stateDir: string): string[] {
    const folder = upgradesFolder(stateDir);
    return existsSync(folder) ? readdirSync(folder).sort() : [];
}

/** The one folder of the upgrades folder whose name ends with `suffix`. */
function folderEndingWith(stateDir: string, suffix: string): string {
    const found = upgradeNames(stateDir).filter((name) => name.endsWith(suffix));
    assert.equal(found.length, 1, `the upgrades folder holds ${JSON.stringify(upgradeNames(stateDir))}`);
    return join(upgradesFolder(stateDir), found[0] ?? "");
}

const copyFolder = (stateDir: string): string => folderEndingWith(stateDir, `-${FIRST_VERSION}-to-${SECOND_VERSION}`);

const INTERNAL_PARTS = ["instructions", "skills", "shipped-files.json"];

/** Every file of `folder` with its bytes, by path relative to it; only the first-level `parts` when they are given. */
function filesOf(folder: string, parts?: readonly string[]): Record<string, string> {
    const entries = readdirSync(folder, { recursive: true, encoding: "utf8" }).sort();
    const files: Record<string, string> = {};
    for (const entry of entries) {
        if (parts && !parts.includes(entry.split("/")[0] ?? "")) continue;
        const path = join(folder, entry);
        if (statSync(path).isFile()) files[entry] = readFileSync(path).toString("base64");
    }
    return files;
}

/** Asserts that `folder` and everything in it is closed to the group and to others, and the folder itself is 0700. */
function assertOwnerOnly(folder: string): void {
    assert.equal(fileMode(folder), OWNER_ONLY_DIR_MODE, `${folder} is not 0700`);
    for (const entry of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
        const mode = fileMode(join(folder, entry));
        assert.equal(mode & GROUP_AND_OTHER_BITS, 0, `${join(folder, entry)} has mode ${mode.toString(8)}`);
    }
}

/** Puts a secret in the store, which the daemon of 0.2.0 removes as it holds no account for it. */
async function plantSecret(stateDir: string): Promise<void> {
    const ownerDir = join(stateDir, "secrets", "planted-owner");
    await mkdir(ownerDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(join(ownerDir, "planted-name.json"), JSON.stringify({ value: PLANTED_SECRET }), {
        mode: OWNER_ONLY_FILE_MODE,
    });
}

/** The job schema version a database file holds, read with the node of the bundle of 0.1.0. */
async function jobSchemaOf(databaseFile: string): Promise<number> {
    const script = [
        'const { DatabaseSync } = require("node:sqlite");',
        "const database = new DatabaseSync(process.argv[1], { readOnly: true });",
        'console.log(database.prepare("SELECT version FROM intern_schema WHERE id = 1").get().version);',
    ].join(" ");
    const node = join(programRoot, "versions", FIRST_VERSION, "node", "bin", "node");
    const result = await runAs(node, ["-e", script, databaseFile]);
    assert.equal(result.status, 0, outputOf(result));
    return Number(result.stdout.trim());
}

type Instance = { server: FakeModelServer; stateDir: string; dataDir: string; jobs: JobKey[] };

/** Installs 0.1.0 with its service on the fake model, and has `JOB_COUNT` jobs done on it. */
async function startInstance(configText: string = CONFIG_TEXT): Promise<Instance> {
    await cleanUpInstall([root]);
    const installed = await runInstallScript("base", ["--version", FIRST_VERSION]);
    assert.equal(installed.status, 0, outputOf(installed));
    const server = await startFakeModelServer(defaultScript);
    await mkdir(configDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(configFile, configText, { mode: OWNER_ONLY_FILE_MODE });
    await writePiAgentDir(piAgentDir, server.baseUrl);
    const service = await runAs(installedBob(), ["service", "install"], { env: { PI_CODING_AGENT_DIR: piAgentDir } });
    assert.equal(service.status, 0, outputOf(service));
    const stateDir = (await serviceStatus()).stateDir ?? "";
    for (let number = 1; number <= JOB_COUNT; number += 1) await createJob(`Answer question ${number}`);
    await waitUntil(
        "every job done",
        async () => (await listJobs()).map((job) => job.status),
        (statuses) => statuses.length === JOB_COUNT && statuses.every((status) => status === "done"),
    );
    const dataDir = (await serviceStatus()).dataDir ?? "";
    return { server, stateDir, dataDir, jobs: await jobKeys() };
}

type UpgradeRun = { status: number | null; stderr: string };
type UpgradeOptions = {
    /** A step the upgrade stops after, until `whileStopped` has run for each stop (counted from 1). */
    stopAfter?: string;
    whileStopped?: (stop: number) => Promise<void>;
};

const releaseFrom = (location: string): Record<string, string> => ({ BOB_RELEASE_URL: locationDir(location) });

/** The environment of an upgrade command: the clean PATH and HOME, the user manager's bus, and the download location. */
function upgradeEnv(location: string): Record<string, string> {
    const env: Record<string, string> = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: homedir(),
        ...releaseFrom(location),
    };
    for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    return env;
}

/** Runs `bob upgrade 0.2.0 --yes` from `location` with standard input closed, so it is not a terminal. */
async function runUpgrade(location: string, options: UpgradeOptions = {}): Promise<UpgradeRun> {
    const env = upgradeEnv(location);
    if (options.stopAfter !== undefined) env.BOB_INSTALL_TEST_STOP_AFTER = options.stopAfter;
    const child = spawn(installedBob(), ["upgrade", SECOND_VERSION, "--yes"], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let stopFailure: unknown = null;
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    const ended = new Promise<number | null>((resolve) => child.once("close", resolve));
    const stops = (): number => stderr.split(`stopped after ${options.stopAfter}`).length - 1;
    /** The hook stops at the step again in the switch-back, which has the step too: each stop is resumed in turn. */
    const resumeStops = async (): Promise<void> => {
        const deadline = Date.now() + STOP_WAIT_MS;
        for (let resumed = 0; child.exitCode === null; ) {
            if (stops() > resumed) {
                resumed += 1;
                await options.whileStopped?.(resumed);
                child.kill("SIGUSR2");
            } else if (Date.now() > deadline) {
                throw new Error(`the upgrade did not stop for resumption ${resumed + 1}: ${stderr}`);
            } else {
                await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
            }
        }
    };
    try {
        if (options.stopAfter !== undefined) {
            void resumeStops().catch((error: unknown) => {
                stopFailure = error;
                child.kill("SIGKILL");
            });
        }
        const status = await ended;
        if (stopFailure !== null) throw stopFailure;
        return { status, stderr };
    } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
    }
}

/** Asserts that the configuration file and the internal folder are byte-identical to those of the copy. */
function assertStateMatchesCopy(instance: Instance): void {
    const copy = copyFolder(instance.stateDir);
    assert.equal(readFileSync(configFile, "utf8"), readFileSync(join(copy, "config.toml"), "utf8"));
    const copied = filesOf(join(copy, "internal"));
    assert.deepEqual(filesOf(instance.dataDir, INTERNAL_PARTS), copied);
    assert.ok(Object.keys(copied).length > 0, "the copy holds no internal file, so the comparison proves nothing");
}

describe("bob upgrade 0.2.0 --yes when 0.2.0 fails before the database", () => {
    let instance: Instance;
    let upgraded: UpgradeRun;
    let databaseInode: number;

    before(async () => {
        instance = await startInstance();
        databaseInode = statSync(join(instance.stateDir, DATABASE_FILE)).ino;
        upgraded = await runUpgrade("fails-before-database");
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 1 reporting the failure, its reason and the switch-back", () => {
        assert.equal(upgraded.status, REFUSED, upgraded.stderr);
        assert.match(upgraded.stderr, /Version 0\.2\.0 didn't become ready: .*this test build fails at step 2/);
        assert.match(upgraded.stderr, /Switched back to version 0\.1\.0\./);
    });

    test("0.1.0 is current and ready with every job", async () => {
        assert.equal(instance.jobs.length, JOB_COUNT);
        await assertReadyWith(FIRST_VERSION, instance.jobs);
    });

    test("the configuration file and the internal folder are byte-identical to the copy", () => {
        assertStateMatchesCopy(instance);
    });

    test("the database is the one 0.1.0 left: never set aside or replaced, at job schema 6", async () => {
        assert.equal(statSync(join(instance.stateDir, DATABASE_FILE)).ino, databaseInode);
        assert.deepEqual(upgradeNames(instance.stateDir), [basename(copyFolder(instance.stateDir))]);
        assert.equal(await jobSchemaOf(join(instance.stateDir, DATABASE_FILE)), 6);
    });

    test("0.2.0 is no longer installed and previous is absent", () => {
        assert.deepEqual(installedVersions(), [FIRST_VERSION]);
        assert.equal(linkedVersion("previous"), null);
    });
});

describe("bob upgrade 0.2.0 --yes when 0.2.0 migrates the database and fails at step 8 on a taken web port", () => {
    let instance: Instance;
    let upgraded: UpgradeRun;
    let holder: Server;
    let port: number;

    before(async () => {
        const free = createServer();
        await new Promise<void>((resolve) => free.listen(0, LOOPBACK, resolve));
        port = (free.address() as { port: number }).port;
        await new Promise<void>((resolve) => free.close(() => resolve()));
        instance = await startInstance(`[network]\naddress = "${LOOPBACK}"\nport = ${port}\n`);
        holder = createServer();
        // The service is stopped once the upgrade took ownership of the instance, so its port is free then. The
        // listener holds the port while 0.2.0 starts, and lets it go when the switch-back has taken ownership.
        upgraded = await runUpgrade("newer-job-schema", {
            stopAfter: "owned",
            whileStopped: async (stop) => {
                if (stop > 1) return new Promise<void>((resolve) => holder.close(() => resolve()));
                return new Promise<void>((resolve, reject) => {
                    holder.once("error", reject);
                    holder.listen(port, LOOPBACK, resolve);
                });
            },
        });
    });

    after(async () => {
        if (holder?.listening) await new Promise<void>((resolve) => holder.close(() => resolve()));
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 1 naming step 8's reason, the address and the port", () => {
        assert.equal(upgraded.status, REFUSED, upgraded.stderr);
        assert.match(upgraded.stderr, /Version 0\.2\.0 didn't become ready: /);
        assert.ok(upgraded.stderr.includes(LOOPBACK), upgraded.stderr);
        assert.ok(upgraded.stderr.includes(String(port)), upgraded.stderr);
        assert.match(upgraded.stderr, /Switched back to version 0\.1\.0\./);
    });

    test("the database 0.2.0 opened is set aside in the upgrades folder and holds job schema 7", async () => {
        const aside = folderEndingWith(instance.stateDir, `-${SECOND_VERSION}-failed-upgrade`);
        assert.equal(await jobSchemaOf(join(aside, DATABASE_FILE)), 7);
    });

    test("0.1.0 is current and ready with every job of the copy, on the database of job schema 6", async () => {
        await assertReadyWith(FIRST_VERSION, instance.jobs);
        assert.equal(await jobSchemaOf(join(instance.stateDir, DATABASE_FILE)), 6);
    });

    test("the configuration file and the internal folder are those of the copy", () => {
        assertStateMatchesCopy(instance);
    });

    test("0.2.0 is no longer installed and previous is absent", () => {
        assert.deepEqual(installedVersions(), [FIRST_VERSION]);
        assert.equal(linkedVersion("previous"), null);
    });
});

const TERMINAL_TIMEOUT_MS = scaled(240_000);

/**
 * Runs `bob upgrade 0.2.0 --yes` on a pseudo-terminal (`script`) and types `reply` once the question about switching back
 * shows. The terminal's whole output is `stdout`.
 */
function runUpgradeOnTerminal(location: string, reply: string): Promise<RunResult> {
    const line = `exec '${installedBob()}' upgrade '${SECOND_VERSION}' --yes`;
    const child = spawn("script", ["-qfec", line, "/dev/null"], {
        env: upgradeEnv(location),
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let isAnswered = false;
    child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (!isAnswered && stdout.includes(ASK_SWITCH_BACK)) {
            isAnswered = true;
            child.stdin.write(`${reply}\n`);
        }
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`bob upgrade on a terminal did not end within ${TERMINAL_TIMEOUT_MS} ms: ${stdout}`));
        }, TERMINAL_TIMEOUT_MS);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

/** The tests that hold when 0.2.0 refused the database and the upgrade switched back to 0.1.0. */
function switchedBackTests(state: () => { instance: Instance; status: number | null; output: string }): void {
    test("it exits 1 saying 0.2.0 can't read the database, and that it switched back to 0.1.0", () => {
        const { status, output } = state();
        assert.equal(status, REFUSED, output);
        assert.match(output, /Version 0\.2\.0 can't read the database: /);
        assert.match(output, /Switched back to version 0\.1\.0\./);
    });

    test("0.1.0 is current and ready with every job", async () => {
        const { instance } = state();
        assert.equal(instance.jobs.length, JOB_COUNT);
        await assertReadyWith(FIRST_VERSION, instance.jobs);
        assert.equal(await jobSchemaOf(join(instance.stateDir, DATABASE_FILE)), 6);
    });

    test("0.2.0 is gone and previous is absent", () => {
        assert.deepEqual(installedVersions(), [FIRST_VERSION]);
        assert.equal(linkedVersion("previous"), null);
    });

    test("the configuration file and the internal folder are those of the copy", () => {
        assertStateMatchesCopy(state().instance);
    });
}

describe("bob upgrade 0.2.0 --yes when 0.2.0 refuses the database, answered yes on a terminal", () => {
    let instance: Instance;
    let upgraded: Awaited<ReturnType<typeof runUpgradeOnTerminal>>;

    before(async () => {
        instance = await startInstance();
        upgraded = await runUpgradeOnTerminal("older-job-schema", "y");
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    switchedBackTests(() => ({ instance, status: upgraded.status, output: outputOf(upgraded) }));

    test("it asked the question on the terminal", () => {
        assert.ok(upgraded.stdout.includes(ASK_SWITCH_BACK), upgraded.stdout);
    });
});

describe("bob upgrade 0.2.0 --yes when 0.2.0 refuses the database, with standard input not a terminal", () => {
    let instance: Instance;
    let upgraded: UpgradeRun;

    before(async () => {
        instance = await startInstance();
        upgraded = await runUpgrade("older-job-schema");
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    switchedBackTests(() => ({ instance, status: upgraded.status, output: upgraded.stderr }));

    test("it took the default without asking", () => {
        assert.ok(!upgraded.stderr.includes(ASK_SWITCH_BACK), upgraded.stderr);
    });
});

describe("bob upgrade 0.2.0 --yes when 0.2.0 refuses the database, answered no on a terminal", () => {
    let instance: Instance;
    let upgraded: RunResult;

    before(async () => {
        instance = await startInstance();
        await plantSecret(instance.stateDir);
        upgraded = await runUpgradeOnTerminal("older-job-schema", "n");
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0 and prints the paths of the set-aside database and the copy", () => {
        assert.equal(upgraded.status, 0, outputOf(upgraded));
        const aside = folderEndingWith(instance.stateDir, `-${SECOND_VERSION}-unreadable`);
        assert.ok(upgraded.stdout.includes(`The database set aside: ${aside}`), upgraded.stdout);
        assert.ok(upgraded.stdout.includes(`The pre-upgrade copy kept: ${copyFolder(instance.stateDir)}`));
    });

    test("the set-aside database is the one 0.1.0 left, and the copy is whole; both are owner-only", async () => {
        const aside = folderEndingWith(instance.stateDir, `-${SECOND_VERSION}-unreadable`);
        const copy = copyFolder(instance.stateDir);
        assert.equal(await jobSchemaOf(join(aside, DATABASE_FILE)), 6);
        assert.deepEqual(readdirSync(copy).sort(), ["config.toml", "copy.json", "database.sqlite", "internal"]);
        assert.ok(readdirSync(aside).includes(DATABASE_FILE), readdirSync(aside).join(","));
        assertOwnerOnly(upgradesFolder(instance.stateDir));
    });

    test("0.2.0 is current and ready with no jobs, on a new database, and 0.1.0 is previous", async () => {
        await assertReadyWith(SECOND_VERSION, []);
        assert.equal(linkedVersion("previous"), FIRST_VERSION);
        assert.deepEqual(installedVersions(), [FIRST_VERSION, SECOND_VERSION]);
        assert.equal(await jobSchemaOf(join(instance.stateDir, DATABASE_FILE)), 5);
    });

    test("the configuration file and the secrets are those 0.2.0 started with", () => {
        assert.equal(readFileSync(configFile, "utf8"), CONFIG_TEXT);
        assert.ok(!existsSync(join(instance.stateDir, "secrets", "planted-owner", "planted-name.json")));
    });

    describe("then bob rollback --yes", () => {
        let rolledBack: RunResult;

        before(async () => {
            rolledBack = await runAs(installedBob(), ["rollback", "--yes"]);
        });

        test("it exits 0 and brings back 0.1.0 with every job", async () => {
            assert.equal(rolledBack.status, 0, outputOf(rolledBack));
            await assertReadyWith(FIRST_VERSION, instance.jobs);
            assert.equal(await jobSchemaOf(join(instance.stateDir, DATABASE_FILE)), 6);
        });
    });
});
