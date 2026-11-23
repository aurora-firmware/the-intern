import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
    cleanUpInstall,
    createJob,
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
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const JOB_COUNT = 3;
const PLANTED_SECRET = "planted-secret-value";
const CONFIG_TEXT = "# A configuration file with no setting: every one keeps its default.\n";
const ASK_ROLLBACK = `Stop the service and roll back to ${FIRST_VERSION}?`;
const ASK_KEEP_DATA = "Keep the instance's data?";
const UNIT_NAME = "the-intern.service";
const INTERNAL_PARTS = ["instructions", "skills", "shipped-files.json"];

const root = join(homedir(), "rollback-uninstall-test");
const piAgentDir = join(root, "pi-agent");
const programRoot = join(homedir(), ".local", "lib", "the-intern");
const configDir = join(homedir(), ".config", "the-intern");
const configFile = join(configDir, "config.toml");

const outputOf = (result: RunResult): string => `${result.stdout}${result.stderr}`;

type DaemonStatus = { phase: string; versions: { intern: string } };
type JobKey = Pick<JobView, "id" | "number" | "title">;
type Instance = { server: FakeModelServer; status: ServiceStatus; stateDir: string; dataDir: string; jobs: JobKey[] };

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

const installedVersions = (): string[] => readdirSync(join(programRoot, "versions")).sort();

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

/** Every file of `folder` with its bytes, by path relative to it; only the first-level `parts` when they are given. */
function filesOf(folder: string, parts?: readonly string[]): Record<string, string> {
    if (!existsSync(folder)) return {};
    const files: Record<string, string> = {};
    for (const entry of readdirSync(folder, { recursive: true, encoding: "utf8" }).sort()) {
        if (parts && !parts.includes(entry.split("/")[0] ?? "")) continue;
        const path = join(folder, entry);
        if (statSync(path).isFile()) files[entry] = readFileSync(path).toString("base64");
    }
    return files;
}

/** Creates a mail account with a password, so the secrets store holds a secret the daemon of either version keeps. */
async function createMailAccount(): Promise<void> {
    const args = ["mail", "create", "intern", "--kind", "owned", "--address", "intern@example.invalid"];
    args.push("--imap-host", "127.0.0.1", "--smtp-host", "127.0.0.1", "--auth", "password");
    const created = await runAs(installedBob(), args, { answers: [{ prompt: "Password: ", reply: PLANTED_SECRET }] });
    assert.equal(created.status, 0, created.stdout);
}

async function waitForJobsDone(count: number): Promise<void> {
    await waitUntil(
        "every job done",
        async () => (await listJobs()).map((job) => job.status),
        (statuses) => statuses.length === count && statuses.every((status) => status === "done"),
    );
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
    await installService();
    for (let number = 1; number <= JOB_COUNT; number += 1) await createJob(`Answer question ${number}`);
    await waitForJobsDone(JOB_COUNT);
    const status = await serviceStatus();
    return { server, status, stateDir: status.stateDir ?? "", dataDir: status.dataDir ?? "", jobs: await jobKeys() };
}

async function installService(): Promise<void> {
    const service = await runAs(installedBob(), ["service", "install"], { env: { PI_CODING_AGENT_DIR: piAgentDir } });
    assert.equal(service.status, 0, outputOf(service));
}

async function assertNoSudo(): Promise<void> {
    assert.notEqual(userInfo().uid, 0);
    const sudo = await runAs("sudo", ["-n", "true"]);
    assert.notEqual(sudo.status, 0, "the account can use sudo, so the test proves nothing about admin rights");
}

/** Whether the user manager knows the service's unit: it doesn't once the unit file is removed. */
async function isUnitKnown(): Promise<boolean> {
    const result = await runAs("systemctl", ["--user", "show", "-p", "LoadState", "--value", UNIT_NAME]);
    return result.stdout.trim() !== "not-found";
}

describe("bob rollback confirmed on a terminal after an upgrade and a new job", () => {
    let instance: Instance;
    let copyFolder: string;
    let copyTime: string;
    let newJob: JobView;
    let secretsBefore: Record<string, string>;
    let rolledBack: RunResult;

    before(async () => {
        instance = await startInstance();
        await createMailAccount();
        const upgraded = await runAs(installedBob(), ["upgrade", SECOND_VERSION, "--yes"], {
            env: { BOB_RELEASE_URL: locationDir("base") },
        });
        assert.equal(upgraded.status, 0, outputOf(upgraded));
        const upgrades = join(instance.stateDir, "upgrades");
        const copyName = readdirSync(upgrades).filter((name) =>
            name.endsWith(`-${FIRST_VERSION}-to-${SECOND_VERSION}`),
        );
        assert.equal(copyName.length, 1, copyName.join(","));
        copyFolder = join(upgrades, copyName[0] ?? "");
        copyTime = (JSON.parse(await readFile(join(copyFolder, "copy.json"), "utf8")) as { time: string }).time;
        newJob = await createJob("Answer the question asked on the second version");
        await waitForJobsDone(JOB_COUNT + 1);
        secretsBefore = filesOf(join(instance.stateDir, "secrets"));
        rolledBack = await runAs(installedBob(), ["rollback"], { answers: [{ prompt: ASK_ROLLBACK, reply: "y" }] });
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0 with no sudo available to the account", async () => {
        assert.equal(rolledBack.status, 0, rolledBack.stdout);
        await assertNoSudo();
    });

    test("the warning names 0.1.0, the upgrade's time, what is lost and the work and mail that may repeat", () => {
        const output = rolledBack.stdout;
        assert.ok(output.includes(`Rolling back to version ${FIRST_VERSION}`), output);
        assert.ok(output.includes(`(${copyTime})`), `the warning doesn't name ${copyTime}: ${output}`);
        assert.match(output, /Everything done since then will be lost: the jobs and conversations/);
        assert.match(output, /Work in progress at the upgrade may run again\./);
        assert.match(output, /Mail received since may be taken in again, and mail sent since may be sent again\./);
    });

    test("0.1.0 is current and ready with every job of the copy and without the new job", async () => {
        assert.equal(instance.jobs.length, JOB_COUNT);
        assert.ok(!instance.jobs.some((job) => job.id === newJob.id));
        await assertReadyWith(FIRST_VERSION, instance.jobs);
    });

    test("the configuration file and the internal folder match the copy", () => {
        assert.equal(readFileSync(configFile, "utf8"), readFileSync(join(copyFolder, "config.toml"), "utf8"));
        const copied = filesOf(join(copyFolder, "internal"));
        assert.deepEqual(filesOf(instance.dataDir, INTERNAL_PARTS), copied);
        assert.ok(Object.keys(copied).length > 0, "the copy holds no internal file, so the comparison proves nothing");
    });

    test("the secrets store is byte-identical to what it was before the rollback", () => {
        assert.ok(
            Object.keys(secretsBefore).length > 0,
            "no secret was in the store, so the comparison proves nothing",
        );
        assert.deepEqual(filesOf(join(instance.stateDir, "secrets")), secretsBefore);
    });

    test("the 0.2.0 database is set aside in the upgrades folder", () => {
        const names = readdirSync(join(instance.stateDir, "upgrades")).filter((name) =>
            name.endsWith(`-${SECOND_VERSION}-rollback`),
        );
        assert.equal(names.length, 1, names.join(","));
        const aside = join(instance.stateDir, "upgrades", names[0] ?? "");
        assert.ok(statSync(join(aside, "the-intern.sqlite")).size > 0, "the set-aside database is empty");
    });

    test("no previous version remains", () => {
        assert.equal(linkedVersion("previous"), null);
        assert.deepEqual(installedVersions(), [FIRST_VERSION]);
    });
});

describe("bob rollback --yes on a fresh install with no previous version", () => {
    let instance: Instance;

    before(async () => {
        instance = await startInstance();
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 1 naming the reason and changes nothing", async () => {
        const state = async (): Promise<object> => ({
            current: linkedVersion("current"),
            previous: linkedVersion("previous"),
            versions: installedVersions(),
            config: readFileSync(configFile, "utf8"),
            internal: filesOf(instance.dataDir, INTERNAL_PARTS),
            upgrades: existsSync(join(instance.stateDir, "upgrades")),
            service: await serviceStatus(),
            jobs: await jobKeys(),
        });
        const before = await state();
        const result = await runAs(installedBob(), ["rollback", "--yes"]);
        assert.equal(result.status, REFUSED, outputOf(result));
        assert.match(result.stderr, /Can't roll back: there is no previous version to go back to\./);
        assert.deepEqual(await state(), before);
        assert.equal((await daemonStatus()).phase, "ready");
    });
});

describe("bob uninstall taking the default on a terminal, with jobs", () => {
    let instance: Instance;
    let uninstalled: RunResult;

    before(async () => {
        instance = await startInstance();
        uninstalled = await runAs(installedBob(), ["uninstall"], { answers: [{ prompt: ASK_KEEP_DATA, reply: "" }] });
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0, and the service, the program and the bob link are gone", async () => {
        assert.equal(uninstalled.status, 0, uninstalled.stdout);
        assert.equal(await isUnitKnown(), false, "the user manager still knows the unit");
        assert.equal(existsSync(programRoot), false);
        assert.equal(existsSync(installedBob()), false);
    });

    test("the instance directories remain and are printed", () => {
        assert.match(uninstalled.stdout, /Kept the instance's directories:/);
        for (const dir of [instance.status.configDir, instance.status.stateDir, instance.status.dataDir]) {
            assert.ok(dir !== null && existsSync(dir), `${dir} was removed`);
            assert.ok(uninstalled.stdout.includes(dir ?? ""), `${dir} is not printed`);
        }
        assert.ok(
            uninstalled.stdout.includes(instance.status.runtimeDir ?? ""),
            "the runtime directory is not printed",
        );
    });

    test("a new install and bob service install find every job", async () => {
        const installed = await runInstallScript("base", ["--version", FIRST_VERSION]);
        assert.equal(installed.status, 0, outputOf(installed));
        await installService();
        await waitUntil(
            "the service ready",
            () => serviceStatus(),
            (status) => status.running,
        );
        assert.equal(instance.jobs.length, JOB_COUNT);
        assert.deepEqual(await jobKeys(), instance.jobs);
    });
});

describe("bob uninstall --yes --remove-data without a terminal", () => {
    let instance: Instance;
    let piAgentBefore: Record<string, string>;
    let uninstalled: RunResult;

    before(async () => {
        instance = await startInstance();
        piAgentBefore = filesOf(piAgentDir);
        uninstalled = await runAs(installedBob(), ["uninstall", "--yes", "--remove-data"]);
    });

    after(async () => {
        await instance?.server.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0, and the service and the program are gone", async () => {
        assert.equal(uninstalled.status, 0, outputOf(uninstalled));
        assert.equal(await isUnitKnown(), false, "the user manager still knows the unit");
        assert.equal(existsSync(programRoot), false);
        assert.equal(existsSync(installedBob()), false);
    });

    test("the instance directories are gone", () => {
        const { configDir: config, stateDir, dataDir, runtimeDir } = instance.status;
        for (const dir of [config, stateDir, dataDir, runtimeDir]) {
            assert.ok(dir !== null);
            assert.equal(existsSync(dir), false, `${dir} remains`);
        }
    });

    test("the pi agent folder is unchanged", () => {
        assert.ok(Object.keys(piAgentBefore).length > 0, "the pi agent folder held no file");
        assert.deepEqual(filesOf(piAgentDir), piAgentBefore);
    });
});
