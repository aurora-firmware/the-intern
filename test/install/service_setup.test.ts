import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
    cleanUpInstall,
    createJob,
    installedBob,
    listJobs,
    type RunResult,
    runAs,
    runInstallScript,
    type ServiceStatus,
    startFakeModelServer,
    waitForServiceState,
    writePiAgentDir,
} from "./cycle_support.ts";
import { defaultScript, type FakeModelServer } from "./fake_model_server.ts";

const VERSION = "0.1.0";
const SERVICE_ACCOUNT = "tester";
const UNIT_NAME = "the-intern.service";
const LOG_COMMAND = `journalctl --user -u ${UNIT_NAME}`;
const REFUSED = 1;
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const LOOPBACK = "127.0.0.1";

const root = join(homedir(), "service-setup-test");
const piAgentDir = join(root, "pi-agent");
const defaultConfigDir = join(homedir(), ".config", "the-intern");

const outputOf = (result: RunResult): string => `${result.stdout}${result.stderr}`;

async function installRelease(): Promise<void> {
    const installed = await runInstallScript("base", ["--version", VERSION]);
    assert.equal(installed.status, 0, outputOf(installed));
}

async function checked(command: string, args: readonly string[]): Promise<string> {
    const result = await runAs(command, args);
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${outputOf(result)}`);
    return result.stdout;
}

const serviceInstall = (env: Record<string, string> = { PI_CODING_AGENT_DIR: piAgentDir }): Promise<RunResult> =>
    runAs(installedBob(), ["service", "install"], { env });

const serviceStatus = (...flags: string[]): Promise<RunResult> =>
    runAs(installedBob(), ["service", "status", ...flags]);

async function statusJson(): Promise<ServiceStatus> {
    const result = await serviceStatus("--json");
    assert.equal(result.status, 0, outputOf(result));
    return JSON.parse(result.stdout) as ServiceStatus;
}

/** The pid of the daemon the user manager runs for the service, which is 0 while none runs. */
async function daemonPid(): Promise<number> {
    const output = await checked("systemctl", ["--user", "show", "-p", "MainPID", "--value", UNIT_NAME]);
    return Number(output.trim());
}

function startedFrom(path: string): boolean {
    return existsSync(join(path, "startup.json"));
}

describe("bob service install with a pi login on the fake model", () => {
    let server: FakeModelServer;
    let installed: RunResult;

    before(async () => {
        await cleanUpInstall([root]);
        await installRelease();
        server = await startFakeModelServer(defaultScript);
        await writePiAgentDir(piAgentDir, server.baseUrl);
        installed = await serviceInstall();
    });

    after(async () => {
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0", () => {
        assert.equal(installed.status, 0, outputOf(installed));
    });

    test("bob service status shows registered, starts at boot, running and the version", async () => {
        const result = await serviceStatus();
        assert.equal(result.status, 0, outputOf(result));
        assert.match(result.stdout, /^Registered: yes$/m);
        assert.match(result.stdout, /^Starts at boot: yes$/m);
        assert.match(result.stdout, new RegExp(`^Running: yes \\(version ${VERSION.replaceAll(".", "\\.")}\\)$`, "m"));
    });

    test("bob service status --json shows registered, starts at boot, running and the version", async () => {
        const status = await statusJson();
        assert.equal(status.registered, true);
        assert.equal(status.startsAtBoot, true);
        assert.equal(status.running, true);
        assert.equal(status.version, VERSION);
    });

    test("the daemon's process is owned by the service account, never root", async () => {
        const pid = await daemonPid();
        assert.ok(pid > 0, `the user manager shows no daemon process: MainPID ${pid}`);
        const { uid } = statSync(`/proc/${pid}`);
        assert.equal(userInfo().username, SERVICE_ACCOUNT);
        assert.equal(uid, userInfo().uid);
        assert.notEqual(uid, 0);
    });
});

describe("bob service install that can't get the daemon ready", () => {
    let server: FakeModelServer;

    before(async () => {
        server = await startFakeModelServer(defaultScript);
    });

    after(async () => {
        await server?.close();
    });

    describe("with no pi login", () => {
        let installed: RunResult;

        before(async () => {
            await cleanUpInstall([root]);
            await installRelease();
            await mkdir(piAgentDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
            installed = await serviceInstall();
        });

        after(async () => {
            await cleanUpInstall([root]);
        });

        test("it exits 1", () => {
            assert.equal(installed.status, REFUSED, outputOf(installed));
        });

        test("it names the daemon's reason", () => {
            assert.match(installed.stderr, /the daemon isn't ready: .*model/i);
        });

        test("it names the command that shows the service's log", () => {
            assert.ok(installed.stderr.includes(LOG_COMMAND), installed.stderr);
        });
    });

    describe("with the web port taken by another listener", () => {
        let holder: Server;
        let port: number;
        let installed: RunResult;

        before(async () => {
            await cleanUpInstall([root]);
            await installRelease();
            await writePiAgentDir(piAgentDir, server.baseUrl);
            holder = createServer();
            await new Promise<void>((resolve) => holder.listen(0, LOOPBACK, resolve));
            const address = holder.address();
            assert.ok(address !== null && typeof address === "object");
            port = address.port;
            await mkdir(defaultConfigDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
            await writeFile(
                join(defaultConfigDir, "config.toml"),
                `[network]\naddress = "${LOOPBACK}"\nport = ${port}\n`,
                { mode: OWNER_ONLY_FILE_MODE },
            );
            installed = await serviceInstall();
        });

        after(async () => {
            await new Promise<void>((resolve) => holder?.close(() => resolve()));
            await cleanUpInstall([root]);
        });

        test("it exits 1", () => {
            assert.equal(installed.status, REFUSED, outputOf(installed));
        });

        test("it names the daemon's reason, the address and the port", () => {
            assert.match(installed.stderr, /the daemon isn't ready: /);
            assert.ok(installed.stderr.includes(LOOPBACK), installed.stderr);
            assert.ok(installed.stderr.includes(String(port)), installed.stderr);
        });

        test("it names the command that shows the service's log", () => {
            assert.ok(installed.stderr.includes(LOG_COMMAND), installed.stderr);
        });
    });
});

describe("a service installed with non-default XDG_STATE_HOME and PI_CODING_AGENT_DIR", () => {
    const xdgState = join(root, "xdg-state");
    const stateDir = join(xdgState, "the-intern");
    const customPiDir = join(root, "custom-pi");
    let server: FakeModelServer;
    let pidBeforeRestart: number;

    before(async () => {
        await cleanUpInstall([root]);
        await installRelease();
        server = await startFakeModelServer(defaultScript);
        await writePiAgentDir(customPiDir, server.baseUrl);
        const installed = await serviceInstall({ XDG_STATE_HOME: xdgState, PI_CODING_AGENT_DIR: customPiDir });
        assert.equal(installed.status, 0, outputOf(installed));
        pidBeforeRestart = await daemonPid();
        await checked("systemctl", ["--user", "restart", UNIT_NAME]);
        await waitForServiceState({ running: true });
    });

    after(async () => {
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("after the unit restarts, the daemon is a new process that runs with the state folder and the pi folder", async () => {
        const pid = await daemonPid();
        assert.ok(pid > 0 && pid !== pidBeforeRestart, `the unit's pid stayed ${pidBeforeRestart}`);
        const words = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        assert.equal(words[words.indexOf("--state-dir") + 1], stateDir);
        const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        assert.ok(environment.includes(`PI_CODING_AGENT_DIR=${customPiDir}`), environment.join("\n"));
    });

    test("the daemon keeps its state in that folder, not in the default one", () => {
        assert.equal(startedFrom(stateDir), true);
        assert.equal(startedFrom(join(homedir(), ".local", "state", "the-intern")), false);
    });

    test("bob service status --json in a shell without the variables shows those folders", async () => {
        const status = await statusJson();
        assert.equal(status.stateDir, stateDir);
        assert.equal(status.piAgentDir, customPiDir);
    });
});

describe("bob service status in each state", () => {
    describe("with no registration", () => {
        before(async () => {
            await cleanUpInstall([root]);
            await installRelease();
        });

        after(async () => {
            await cleanUpInstall([root]);
        });

        test("it reports not registered, not running and exits 0", async () => {
            const result = await serviceStatus();
            assert.equal(result.status, 0, outputOf(result));
            assert.match(result.stdout, /^Registered: no$/m);
            assert.match(result.stdout, /^Running: no$/m);
        });

        test("with --json it reports not registered and not running and exits 0", async () => {
            const status = await statusJson();
            assert.equal(status.registered, false);
            assert.equal(status.running, false);
            assert.equal(status.version, null);
        });
    });

    describe("with the service registered", () => {
        let server: FakeModelServer;

        before(async () => {
            await cleanUpInstall([root]);
            await installRelease();
            server = await startFakeModelServer(defaultScript);
            await writePiAgentDir(piAgentDir, server.baseUrl);
            const installed = await serviceInstall();
            assert.equal(installed.status, 0, outputOf(installed));
        });

        after(async () => {
            await server?.close();
            await cleanUpInstall([root]);
        });

        async function stopService(): Promise<void> {
            await checked("systemctl", ["--user", "stop", UNIT_NAME]);
            await waitForServiceState({ running: false });
        }

        async function startService(): Promise<void> {
            await checked("systemctl", ["--user", "start", UNIT_NAME]);
            await waitForServiceState({ running: true });
        }

        test("stopped, it reports registered and not running and exits 0", async () => {
            await stopService();
            const result = await serviceStatus();
            assert.equal(result.status, 0, outputOf(result));
            assert.match(result.stdout, /^Registered: yes$/m);
            assert.match(result.stdout, /^Running: no$/m);
        });

        test("stopped, with --json it reports registered and not running, with no version", async () => {
            await stopService();
            const status = await statusJson();
            assert.equal(status.registered, true);
            assert.equal(status.running, false);
            assert.equal(status.version, null);
        });

        test("running, it reports registered and running with the version and exits 0", async () => {
            await startService();
            const result = await serviceStatus();
            assert.equal(result.status, 0, outputOf(result));
            assert.match(result.stdout, /^Registered: yes$/m);
            assert.match(
                result.stdout,
                new RegExp(`^Running: yes \\(version ${VERSION.replaceAll(".", "\\.")}\\)$`, "m"),
            );
        });

        test("running, with --json it reports registered and running with the version", async () => {
            await startService();
            const status = await statusJson();
            assert.equal(status.registered, true);
            assert.equal(status.running, true);
            assert.equal(status.version, VERSION);
        });
    });
});

describe("bob service remove with jobs", () => {
    let server: FakeModelServer;
    let jobIds: string[];
    let removed: RunResult;

    before(async () => {
        await cleanUpInstall([root]);
        await installRelease();
        server = await startFakeModelServer(defaultScript);
        await writePiAgentDir(piAgentDir, server.baseUrl);
        const installed = await serviceInstall();
        assert.equal(installed.status, 0, outputOf(installed));
        jobIds = [(await createJob("Answer the first request")).id, (await createJob("Answer the second request")).id];
        removed = await runAs(installedBob(), ["service", "remove"]);
    });

    after(async () => {
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("it exits 0", () => {
        assert.equal(removed.status, 0, outputOf(removed));
    });

    test("the service is stopped and unregistered", async () => {
        const status = await statusJson();
        assert.equal(status.registered, false);
        assert.equal(status.running, false);
        const active = await runAs("systemctl", ["--user", "is-active", UNIT_NAME]);
        assert.notEqual(active.status, 0, "the unit must not be active");
        assert.equal(existsSync(join(homedir(), ".config", "systemd", "user", UNIT_NAME)), false);
    });

    test("bob still runs", async () => {
        const result = await runAs(installedBob(), ["--help"]);
        assert.equal(result.status, 0, outputOf(result));
        assert.match(outputOf(result), /Usage: bob/);
    });

    test("a later bob service install finds every job", async () => {
        const installed = await serviceInstall();
        assert.equal(installed.status, 0, outputOf(installed));
        const found = (await listJobs()).map((job) => job.id);
        for (const id of jobIds) assert.ok(found.includes(id), `job ${id} is missing from ${found.join(", ")}`);
    });
});
