import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scaled } from "../support/time_scale.ts";
import {
    cleanUpInstall,
    createJob,
    installedBob,
    locationDir,
    type RunResult,
    runAs,
    runInstallScript,
    type ServiceStatus,
    startFakeModelServer,
    waitForProcess,
    waitUntil,
    writePiAgentDir,
} from "./cycle_support.ts";
import { type FakeModelServer, SLOW_TOOL_COMMAND, slowScript } from "./fake_model_server.ts";

const FIRST_VERSION = "0.1.0";
const SECOND_VERSION = "0.2.0";
const SERVICE_ACCOUNT = "tester";
const UNIT_NAME = "the-intern.service";
const REFUSED = 1;
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const PLANTED_SECRET = "planted-secret-value";
const STOP_WAIT_MS = scaled(60_000);

const root = join(homedir(), "upgrade-test");
const piAgentDir = join(root, "pi-agent");
const programRoot = join(homedir(), ".local", "lib", "the-intern");
const defaultStateDir = join(homedir(), ".local", "state", "the-intern");

const outputOf = (result: RunResult): string => `${result.stdout}${result.stderr}`;
const releaseFrom = (location: string): Record<string, string> => ({ BOB_RELEASE_URL: locationDir(location) });

type DaemonStatus = { phase: string; versions: { intern: string } };

async function installFirstVersion(): Promise<void> {
    const installed = await runInstallScript("base", ["--version", FIRST_VERSION]);
    assert.equal(installed.status, 0, outputOf(installed));
}

/** Writes the configuration file the copy must hold: the daemon writes none of its own. */
async function writeConfigFile(): Promise<void> {
    const configDir = join(homedir(), ".config", "the-intern");
    await mkdir(configDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(
        join(configDir, "config.toml"),
        "# A configuration file with no setting: every one keeps its default.\n",
        {
            mode: OWNER_ONLY_FILE_MODE,
        },
    );
}

async function installService(server: FakeModelServer, env: Record<string, string> = {}): Promise<void> {
    await writeConfigFile();
    await writePiAgentDir(piAgentDir, server.baseUrl);
    const installed = await runAs(installedBob(), ["service", "install"], {
        env: { PI_CODING_AGENT_DIR: piAgentDir, ...env },
    });
    assert.equal(installed.status, 0, outputOf(installed));
}

async function serviceStatus(): Promise<ServiceStatus> {
    const result = await runAs(installedBob(), ["service", "status", "--json"]);
    assert.equal(result.status, 0, outputOf(result));
    return JSON.parse(result.stdout) as ServiceStatus;
}

async function daemonStatus(): Promise<DaemonStatus> {
    const result = await runAs(installedBob(), ["status", "--json"]);
    assert.equal(result.status, 0, outputOf(result));
    return JSON.parse(result.stdout) as DaemonStatus;
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

function installedVersions(): string[] {
    return readdirSync(join(programRoot, "versions")).sort();
}

/** The names in the upgrades folder of `stateDir`; empty when the folder doesn't exist. */
function upgradeCopies(stateDir: string): string[] {
    const folder = join(stateDir, "upgrades");
    return existsSync(folder) ? readdirSync(folder).sort() : [];
}

/** The pid of the daemon the user manager runs for the service, which is 0 while none runs. */
async function daemonPid(): Promise<number> {
    const result = await runAs("systemctl", ["--user", "show", "-p", "MainPID", "--value", UNIT_NAME]);
    assert.equal(result.status, 0, outputOf(result));
    return Number(result.stdout.trim());
}

/** The state the installation is in: its versions and what the service runs. */
async function snapshot(): Promise<object> {
    const status = await serviceStatus();
    return {
        current: linkedVersion("current"),
        previous: linkedVersion("previous"),
        versions: installedVersions(),
        running: status.running,
        version: status.version,
    };
}

/** Puts a secret in the store, which the daemon of 0.2.0 removes as it holds no account for it, after the copy. */
async function plantSecret(stateDir: string): Promise<void> {
    const ownerDir = join(stateDir, "secrets", "planted-owner");
    await mkdir(ownerDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(join(ownerDir, "planted-name.json"), JSON.stringify({ value: PLANTED_SECRET }), {
        mode: OWNER_ONLY_FILE_MODE,
    });
}

describe("bob upgrade 0.2.0 --yes with a run in a tool call", () => {
    let server: FakeModelServer;
    let upgraded: RunResult;
    let stateDir: string;
    let copyName: string;
    let slowRunRequests: number;

    before(async () => {
        await cleanUpInstall([root]);
        await installFirstVersion();
        server = await startFakeModelServer(slowScript);
        await installService(server);
        stateDir = (await serviceStatus()).stateDir ?? "";
        await createJob("Run the slow command");
        await waitForProcess(SLOW_TOOL_COMMAND);
        await plantSecret(stateDir);
        slowRunRequests = server.requests().length;
        upgraded = await runAs(installedBob(), ["upgrade", SECOND_VERSION, "--yes"], { env: releaseFrom("base") });
        copyName = upgradeCopies(stateDir).join(",");
    });

    after(async () => {
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0 and names the upgrade's steps", () => {
        assert.equal(upgraded.status, 0, outputOf(upgraded));
        assert.match(upgraded.stderr, /Stopping the service\./);
        assert.match(upgraded.stderr, /Waiting for the version to be ready\./);
    });

    test("the upgrades folder holds one copy from 0.1.0 for 0.2.0", async () => {
        assert.match(copyName, new RegExp(`^[^,]+-${FIRST_VERSION}-to-${SECOND_VERSION}$`), copyName);
        const info = JSON.parse(await readFile(join(stateDir, "upgrades", copyName, "copy.json"), "utf8")) as {
            from: string;
            to: string;
        };
        assert.equal(info.from, FIRST_VERSION);
        assert.equal(info.to, SECOND_VERSION);
    });

    test("the copy holds the database, the configuration file and the internal folder and nothing else", () => {
        const folder = join(stateDir, "upgrades", copyName);
        assert.deepEqual(readdirSync(folder).sort(), ["config.toml", "copy.json", "database.sqlite", "internal"]);
        assert.ok(statSync(join(folder, "database.sqlite")).size > 0, "the copied database is empty");
        assert.ok(statSync(join(folder, "internal")).isDirectory());
    });

    test("the copy holds no file of the secrets store", () => {
        const folder = join(stateDir, "upgrades", copyName);
        const files = readdirSync(folder, { recursive: true, encoding: "utf8" });
        assert.deepEqual(
            files.filter((file) => /secret|planted/i.test(file)),
            [],
        );
        for (const file of files) {
            const path = join(folder, file);
            if (statSync(path).isFile()) assert.ok(!readFileSync(path).includes(PLANTED_SECRET), `${file} holds it`);
        }
    });

    test("bob status reports 0.2.0 and ready", async () => {
        const status = await daemonStatus();
        assert.equal(status.versions.intern, SECOND_VERSION);
        assert.equal(status.phase, "ready");
        assert.equal((await serviceStatus()).version, SECOND_VERSION);
    });

    test("the job's run resumes with an interrupted result, once, without a new start", async () => {
        const hasInterrupted = (): boolean =>
            server
                .requests()
                .some((transcript) => transcript.some((m) => m.role === "toolResult" && /interrupted/.test(m.text)));
        await waitUntil("the model receiving an interrupted tool result", async () => hasInterrupted(), Boolean);
        const starts = server.requests().filter((transcript) => !transcript.some((m) => m.role === "toolResult"));
        assert.equal(starts.length, 1, "the lead started its run again instead of resuming it");
        assert.equal(slowRunRequests, 1, "the run had not asked the model before the upgrade");
    });

    test("previous is 0.1.0 and current is 0.2.0", () => {
        assert.equal(linkedVersion("previous"), FIRST_VERSION);
        assert.equal(linkedVersion("current"), SECOND_VERSION);
    });

    test("the daemon runs as the service account, and no sudo was available", async () => {
        const pid = await daemonPid();
        assert.ok(pid > 0, `the user manager shows no daemon process: MainPID ${pid}`);
        assert.equal(userInfo().username, SERVICE_ACCOUNT);
        assert.equal(statSync(`/proc/${pid}`).uid, userInfo().uid);
        assert.notEqual(userInfo().uid, 0);
        const sudo = await runAs("sudo", ["-n", "true"]);
        assert.notEqual(sudo.status, 0, "the account can use sudo, so the test proves nothing about admin rights");
    });

    test("bob upgrade 0.2.0 says it is already on 0.2.0, exits 0 and changes nothing", async () => {
        const before = await snapshot();
        const again = await runAs(installedBob(), ["upgrade", SECOND_VERSION], { env: releaseFrom("base") });
        assert.equal(again.status, 0, outputOf(again));
        assert.match(again.stderr, /Already on version 0\.2\.0\./);
        assert.deepEqual(await snapshot(), before);
    });

    test("bob upgrade 0.1.0 exits 1 pointing to bob rollback and changes nothing", async () => {
        const before = await snapshot();
        const older = await runAs(installedBob(), ["upgrade", FIRST_VERSION], { env: releaseFrom("base") });
        assert.equal(older.status, REFUSED, outputOf(older));
        assert.match(older.stderr, /older than the current one; use `bob rollback`/);
        assert.deepEqual(await snapshot(), before);
    });
});

describe("bob upgrade with no version, after a service installed with a non-default XDG_STATE_HOME", () => {
    const xdgState = join(root, "xdg-state");
    const customStateDir = join(xdgState, "the-intern");
    let server: FakeModelServer;
    let upgraded: RunResult;

    before(async () => {
        await cleanUpInstall([root]);
        await installFirstVersion();
        server = await startFakeModelServer(slowScript);
        await installService(server, { XDG_STATE_HOME: xdgState });
        assert.equal((await serviceStatus()).stateDir, customStateDir);
        upgraded = await runAs(installedBob(), ["upgrade", "--yes"], { env: releaseFrom("base") });
    });

    after(async () => {
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0 and the service runs 0.2.0, the latest", async () => {
        assert.equal(upgraded.status, 0, outputOf(upgraded));
        assert.equal((await daemonStatus()).versions.intern, SECOND_VERSION);
    });

    test("the copy is taken from that state directory, not from the default one", () => {
        const copies = upgradeCopies(customStateDir);
        assert.equal(copies.length, 1, copies.join(","));
        assert.match(copies[0] ?? "", new RegExp(`-${FIRST_VERSION}-to-${SECOND_VERSION}$`));
        assert.ok(existsSync(join(customStateDir, "upgrades", copies[0] ?? "", "database.sqlite")));
        assert.deepEqual(upgradeCopies(defaultStateDir), []);
    });
});

type StoppedCommand = { child: ChildProcess; stderr(): string; ended: Promise<number | null> };

/** Starts `bob upgrade` with the test hook that stops it after `step`, and resolves once it says it stopped. */
async function startUpgradeStoppedAfter(step: string): Promise<StoppedCommand> {
    const env: Record<string, string> = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: homedir(),
        ...releaseFrom("base"),
        BOB_INSTALL_TEST_STOP_AFTER: step,
    };
    for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    const child = spawn(installedBob(), ["upgrade", SECOND_VERSION, "--yes"], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let text = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
    });
    const ended = new Promise<number | null>((resolve) => child.once("close", resolve));
    const stderr = (): string => text;
    await waitUntil(
        `the upgrade stopping after ${step}`,
        async () => text,
        (seen) => seen.includes(`stopped after ${step}`),
        STOP_WAIT_MS,
    );
    return { child, stderr, ended };
}

describe("bob upgrade stopped after it took ownership of the instance", () => {
    let server: FakeModelServer;
    let upgrade: StoppedCommand;
    let ownerPid: number;
    let serve: RunResult;
    let rollback: RunResult;
    let uninstall: RunResult;
    let upgradeStatus: number | null;

    before(async () => {
        await cleanUpInstall([root]);
        await installFirstVersion();
        server = await startFakeModelServer(slowScript);
        await installService(server);
        const status = await serviceStatus();
        upgrade = await startUpgradeStoppedAfter("owned");
        ownerPid = upgrade.child.pid ?? 0;
        const dirs = [
            ["--config-dir", status.configDir],
            ["--state-dir", status.stateDir],
            ["--data-dir", status.dataDir],
            ["--runtime-dir", status.runtimeDir],
        ].flat() as string[];
        serve = await runAs(installedBob(), ["serve", ...dirs], { env: { PI_CODING_AGENT_DIR: piAgentDir } });
        rollback = await runAs(installedBob(), ["rollback", "--yes"]);
        uninstall = await runAs(installedBob(), ["uninstall", "--yes"]);
        upgrade.child.kill("SIGUSR2");
        upgradeStatus = await upgrade.ended;
    });

    after(async () => {
        if (upgrade?.child.exitCode === null) upgrade.child.kill("SIGKILL");
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("bob serve for the instance is refused at startup step 3, naming the owner", () => {
        assert.equal(serve.status, REFUSED, outputOf(serve));
        assert.match(serve.stderr, /startup failed step=3 name="take ownership"/);
        assert.ok(serve.stderr.includes(`is owned by a running daemon (pid ${ownerPid})`), serve.stderr);
    });

    test("bob rollback exits 1 naming the running upgrade", () => {
        assert.equal(rollback.status, REFUSED, outputOf(rollback));
        assert.ok(rollback.stderr.includes(`upgrade is running (pid ${ownerPid})`), rollback.stderr);
    });

    test("bob uninstall exits 1 naming the running upgrade, and removes nothing", () => {
        assert.equal(uninstall.status, REFUSED, outputOf(uninstall));
        assert.ok(uninstall.stderr.includes(`upgrade is running (pid ${ownerPid})`), uninstall.stderr);
        assert.ok(existsSync(join(programRoot, "versions", SECOND_VERSION)));
    });

    test("after SIGUSR2 the upgrade completes and 0.2.0 is ready", async () => {
        assert.equal(upgradeStatus, 0, upgrade.stderr());
        const status = await daemonStatus();
        assert.equal(status.versions.intern, SECOND_VERSION);
        assert.equal(status.phase, "ready");
        assert.equal(linkedVersion("previous"), FIRST_VERSION);
    });
});

describe("bob upgrade against a download location with a bad bundle", () => {
    let server: FakeModelServer;

    before(async () => {
        await cleanUpInstall([root]);
        await installFirstVersion();
        server = await startFakeModelServer(slowScript);
        await installService(server);
    });

    after(async () => {
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("a bundle that differs from its checksum is refused naming the mismatch, with nothing changed", async () => {
        const before = await snapshot();
        const result = await runAs(installedBob(), ["upgrade", SECOND_VERSION, "--yes"], {
            env: releaseFrom("tampered"),
        });
        assert.equal(result.status, REFUSED, outputOf(result));
        assert.match(result.stderr, /Checksum mismatch for the-intern-0\.2\.0-linux-x64\.tar\.gz/);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(before, {
            current: FIRST_VERSION,
            previous: null,
            versions: [FIRST_VERSION],
            running: true,
            version: FIRST_VERSION,
        });
    });

    test("a bundle with no checksum file is refused naming the missing checksum, with nothing changed", async () => {
        const before = await snapshot();
        const result = await runAs(installedBob(), ["upgrade", SECOND_VERSION, "--yes"], {
            env: releaseFrom("no-checksum"),
        });
        assert.equal(result.status, REFUSED, outputOf(result));
        assert.match(result.stderr, /Missing checksum: .*the-intern-0\.2\.0-linux-x64\.tar\.gz\.sha256 was not found/);
        assert.deepEqual(await snapshot(), before);
    });
});
