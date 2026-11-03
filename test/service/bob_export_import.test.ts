import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;

type JobView = { id: string; number: string; status: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function newEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

async function readyDaemon(env: HermeticEnv): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

const getJob = async (daemon: DaemonProcess, job: string) => (await daemon.invoke("jobs.get", { job })) as JobView;

async function runningJob(daemon: DaemonProcess): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", { text: "do it" })) as JobView;
    const deadline = Date.now() + WAIT_MS;
    while ((await getJob(daemon, created.id)).status !== "in_progress") {
        assert.ok(Date.now() < deadline, `timed out waiting for ${created.id} to be in progress`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return getJob(daemon, created.id);
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

function importArgs(file: string, env: HermeticEnv): string[] {
    return [
        "import",
        file,
        "--config-dir",
        env.configDir,
        "--state-dir",
        env.stateDir,
        "--data-dir",
        env.dataDir,
        "--runtime-dir",
        env.runtimeDir,
    ];
}

describe("bob export", () => {
    it("prints the absolute path and the size written while the jobs go on", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env);
        const job = await runningJob(daemon);

        const result = await runBob(["export", "backup.db"], {
            runtimeDir: env.runtimeDir,
            env: env.env,
            cwd: env.root,
        });

        const file = join(env.root, "backup.db");
        assert.equal(result.status, 0, result.stderr);
        const { size } = await stat(file);
        assert.ok(size > 0);
        assert.ok(result.stdout.includes(file), result.stdout);
        assert.ok(result.stdout.includes(String(size)), result.stdout);
        assert.equal((await getJob(daemon, job.id)).status, "in_progress");
    });

    it("prints the daemon's answer as JSON with --json", async () => {
        const env = await newEnv();
        await readyDaemon(env);

        const result = await runBob(["export", "backup.db", "--json"], {
            runtimeDir: env.runtimeDir,
            env: env.env,
            cwd: env.root,
        });

        assert.equal(result.status, 0, result.stderr);
        const file = join(env.root, "backup.db");
        assert.deepEqual(JSON.parse(result.stdout), { path: file, size: (await stat(file)).size });
    });
});

describe("bob import", () => {
    it("lets a new instance start with every job of the export", async () => {
        const source = await newEnv();
        const sourceDaemon = await readyDaemon(source);
        const job = await runningJob(sourceDaemon);
        const exported = await runBob(["export", "backup.db"], {
            runtimeDir: source.runtimeDir,
            env: source.env,
            cwd: source.root,
        });
        assert.equal(exported.status, 0, exported.stderr);
        await stopDaemon(sourceDaemon);
        const target = await newEnv();

        const result = await runBob(importArgs("backup.db", target), { env: target.env, cwd: source.root });

        assert.equal(result.status, 0, result.stderr);
        const targetDaemon = await readyDaemon(target);
        assert.equal((await getJob(targetDaemon, job.id)).number, job.number);
    });

    it("refuses while a daemon runs the instance, with the lock holder's message, and changes nothing", async () => {
        const source = await newEnv();
        await readyDaemon(source);
        await runBob(["export", "backup.db"], { runtimeDir: source.runtimeDir, env: source.env, cwd: source.root });
        const target = await newEnv();
        await readyDaemon(target);
        const before = await readdir(target.stateDir);

        const result = await runBob(importArgs(join(source.root, "backup.db"), target), { env: target.env });

        assert.equal(result.status, 1);
        assert.match(result.stderr, /a running daemon \(pid \d+\) owns/);
        assert.deepEqual(await readdir(target.stateDir), before);
    });

    it("refuses an instance that already has a database and says so on standard error", async () => {
        const source = await newEnv();
        const sourceDaemon = await readyDaemon(source);
        await runBob(["export", "backup.db"], { runtimeDir: source.runtimeDir, env: source.env, cwd: source.root });
        await stopDaemon(sourceDaemon);

        const result = await runBob(importArgs(join(source.root, "backup.db"), source), { env: source.env });

        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /already holds a database file/);
    });

    it("refuses a file that is not a SQLite database", async () => {
        const target = await newEnv();
        await writeFile(join(target.root, "notes.txt"), "not a database, just notes that are long enough to read");

        const result = await runBob(importArgs(join(target.root, "notes.txt"), target), { env: target.env });

        assert.equal(result.status, 1);
        assert.match(result.stderr, /not a SQLite database/);
        assert.deepEqual(await readdir(target.stateDir), []);
    });
});
