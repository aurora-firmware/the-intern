import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scaled } from "../support/time_scale.ts";
import {
    type BobTarget,
    cleanUpInstall,
    createJob,
    fileMode,
    installedBob,
    listJobs,
    runAs,
    runInstallScript,
    startFakeModelServer,
    waitForProcess,
    waitForServiceState,
    waitUntil,
    writePiAgentDir,
} from "./cycle_support.ts";
import { defaultScript, type FakeModelServer, SLOW_TOOL_COMMAND, slowScript } from "./fake_model_server.ts";

const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const EXIT_BOUND_MS = scaled(60_000);
const SLOW_MARKER = "slow";

type Daemon = { target: BobTarget; stop(): Promise<void> };

const root = join(homedir(), "fake-model-test");
const piAgentDir = join(root, "pi-agent");

/** The slow script answers a job whose request says `slow`; every other job gets the default one. */
const scriptByRequest: Parameters<typeof startFakeModelServer>[0] = (transcript) =>
    transcript[0]?.text.includes(SLOW_MARKER) ? slowScript(transcript) : defaultScript(transcript);

async function startDaemonByHand(): Promise<Daemon> {
    const dirs = Object.fromEntries(["config", "state", "data", "runtime"].map((name) => [name, join(root, name)]));
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const child: ChildProcess = spawn(
        installedBob(),
        [
            "serve",
            "--config-dir",
            dirs.config,
            "--state-dir",
            dirs.state,
            "--data-dir",
            dirs.data,
            "--runtime-dir",
            dirs.runtime,
        ],
        {
            env: { PATH: "/usr/bin:/bin", HOME: homedir(), PI_CODING_AGENT_DIR: piAgentDir },
            stdio: ["ignore", "ignore", "pipe"],
        },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const target: BobTarget = { runtimeDir: dirs.runtime };
    const stop = async (): Promise<void> => {
        child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`the daemon did not exit within ${EXIT_BOUND_MS} ms: ${stderr}`)),
                EXIT_BOUND_MS,
            );
        });
        try {
            await Promise.race([exited, bound]);
        } finally {
            clearTimeout(timer);
        }
    };
    await waitUntil(
        `the daemon reaching ready (stderr: ${stderr})`,
        async () => {
            const result = await runAs(installedBob(), ["status", "--json", "--runtime-dir", dirs.runtime]);
            return result.status === 0 ? (JSON.parse(result.stdout) as { phase: string }).phase : "not answering";
        },
        (phase) => phase === "ready",
    );
    return { target, stop };
}

async function installFirstVersion(): Promise<void> {
    const installed = await runInstallScript("base", ["--version", "0.1.0"]);
    assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
}

describe("a daemon started by hand from the 0.1.0 bundle on the fake model", () => {
    let server: FakeModelServer;
    let daemon: Daemon;
    let stopped = false;

    before(async () => {
        await installFirstVersion();
        server = await startFakeModelServer(scriptByRequest);
        await writePiAgentDir(piAgentDir, server.baseUrl);
        daemon = await startDaemonByHand();
    });

    after(async () => {
        if (!stopped) await daemon.stop();
        await server.close();
        await cleanUpInstall([root]);
    });

    test("the pi agent folder and its files are owner-only", () => {
        assert.equal(fileMode(piAgentDir), OWNER_ONLY_DIR_MODE);
        for (const file of ["models.json", "settings.json", "auth.json"]) {
            assert.equal(fileMode(join(piAgentDir, file)), OWNER_ONLY_FILE_MODE, file);
        }
    });

    test("the daemon reaches ready and runs the 0.1.0 program", async () => {
        const result = await runAs(installedBob(), [
            "status",
            "--json",
            "--runtime-dir",
            daemon.target.runtimeDir ?? "",
        ]);
        const status = JSON.parse(result.stdout) as { phase: string; versions: { intern: string } };
        assert.equal(status.phase, "ready");
        assert.equal(status.versions.intern, "0.1.0");
    });

    test("the default script completes a job", async () => {
        const job = await createJob("say that it is done", daemon.target);
        await waitUntil(
            "the job being Done",
            () => listJobs(daemon.target),
            (jobs) => jobs.some((listed) => listed.id === job.id && listed.status === "done"),
        );
    });

    test("the slow script keeps the lead in a tool call until the daemon stops", async () => {
        const job = await createJob(`this one is ${SLOW_MARKER}`, daemon.target);
        await waitForProcess(SLOW_TOOL_COMMAND);
        const listed = (await listJobs(daemon.target)).find((candidate) => candidate.id === job.id);
        assert.equal(listed?.status, "in_progress");
        await daemon.stop();
        stopped = true;
        const slowTranscripts = server.requests().filter((transcript) => transcript[0]?.text.includes(SLOW_MARKER));
        assert.equal(slowTranscripts.length, 1, "the lead asked the model again before the daemon stopped");
    });
});

describe("cleanUpInstall after a test that registered the service", () => {
    let server: FakeModelServer;

    before(async () => {
        await installFirstVersion();
        server = await startFakeModelServer(defaultScript);
        await writePiAgentDir(piAgentDir, server.baseUrl);
    });

    after(async () => {
        await server.close();
        await cleanUpInstall([root]);
    });

    test("leaves no unit, program folder, bob link or instance directory, without bob uninstall", async () => {
        const registered = await runAs(installedBob(), ["service", "install"], {
            env: { PI_CODING_AGENT_DIR: piAgentDir },
        });
        assert.equal(registered.status, 0, `${registered.stdout}${registered.stderr}`);
        const status = await waitForServiceState({ registered: true, running: true });
        const instanceDirs = [status.configDir, status.stateDir, status.dataDir, status.runtimeDir];
        assert.ok(instanceDirs.every((dir) => dir !== null && existsSync(dir)));

        await cleanUpInstall([piAgentDir]);

        const home = homedir();
        const left = [
            join(home, ".config", "systemd", "user", "the-intern.service"),
            join(home, ".local", "lib", "the-intern"),
            join(home, ".local", "bin", "bob"),
            piAgentDir,
            ...instanceDirs.filter((dir): dir is string => dir !== null),
        ].filter((path) => existsSync(path));
        assert.deepEqual(left, []);
        const unit = await runAs("systemctl", ["--user", "is-active", "the-intern.service"]);
        assert.notEqual(unit.stdout.trim(), "active");
    });
});
