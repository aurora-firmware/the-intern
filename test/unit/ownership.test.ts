import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    acquireInstallLock,
    acquireOwnership,
    InstallLockRefusedError,
    OwnershipRefusedError,
    readOwnerLock,
} from "../../src/daemon/ownership.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const OWNERSHIP_MODULE = new URL("../../src/daemon/ownership.ts", import.meta.url).href;
const BOOT_TIME_TOLERANCE_MS = 60_000;

// A child that acquires ownership when told to and keeps running until its stdin closes, so the lock it wins
// keeps naming a live process.
const ACQUIRING_CHILD = `
import { acquireOwnership } from ${JSON.stringify(OWNERSHIP_MODULE)};
process.stdin.once("data", async () => {
    try {
        await acquireOwnership(process.argv[1]);
        console.log("granted");
    } catch (error) {
        console.log("refused");
    }
});
process.stdin.on("end", () => process.exit(0));
console.log("ready");
`;

// A child that reads the lock file in a tight loop and counts the contents that are not complete JSON.
const LOCK_WATCHING_CHILD = `
import { readFileSync } from "node:fs";
let unreadable = 0;
let isStopped = false;
process.stdin.once("data", () => { isStopped = true; });
console.log("ready");
const poll = () => {
    const deadline = Date.now() + 20;
    while (Date.now() < deadline) {
        try {
            JSON.parse(readFileSync(process.argv[1], "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") unreadable++;
        }
    }
    if (isStopped) {
        console.log(unreadable + " unreadable");
        process.exit(0);
    }
    setImmediate(poll);
};
poll();
`;

const IDLE_CHILD = `
console.log("ready");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

type LockContent = { pid: number; bootTime: number; token: string };

function currentBootTime(): number {
    return Math.round((Date.now() - uptime() * 1000) / 1000) * 1000;
}

function nextLine(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
        child.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
        child.once("error", reject);
    });
}

async function startChild(script: string, args: string[] = []): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
        stdio: ["pipe", "pipe", "inherit"],
    });
    assert.equal(await nextLine(child), "ready");
    return child;
}

function stopChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.stdin?.end();
    });
}

async function exitedChildPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.ok(child.pid);
    return child.pid;
}

async function readLock(stateDir: string): Promise<LockContent> {
    return JSON.parse(await readFile(join(stateDir, "owner.lock"), "utf8"));
}

describe("acquireOwnership", () => {
    let env: HermeticEnv;
    let children: ChildProcess[];

    beforeEach(async () => {
        env = await createHermeticEnv();
        children = [];
    });

    afterEach(async () => {
        await Promise.all(children.filter((child) => child.exitCode === null).map(stopChild));
        await env.dispose();
    });

    async function trackedChild(script: string, args: string[] = []): Promise<ChildProcess> {
        const child = await startChild(script, args);
        children.push(child);
        return child;
    }

    it("creates an owner-only lock file holding this pid and the boot time when none exists", async () => {
        await acquireOwnership(env.stateDir);

        const lock = await readLock(env.stateDir);
        assert.equal(lock.pid, process.pid);
        assert.ok(Math.abs(lock.bootTime - currentBootTime()) <= BOOT_TIME_TOLERANCE_MS);
        assert.equal(typeof lock.token, "string");
        assert.ok(lock.token.length > 0);
        assert.equal((await stat(join(env.stateDir, "owner.lock"))).mode & 0o777, 0o600);
    });

    it("never shows an empty or partial lock file to a reader while acquiring", async () => {
        const reader = await trackedChild(LOCK_WATCHING_CHILD, [join(env.stateDir, "owner.lock")]);
        const report = nextLine(reader);
        for (let attempt = 0; attempt < 200; attempt++) {
            const handle = await acquireOwnership(env.stateDir);
            await handle.release();
        }
        reader.stdin?.write("stop\n");

        assert.equal(await report, "0 unreadable");
    });

    it("refuses and leaves the file unchanged when the lock names a live process", async () => {
        const live = await trackedChild(IDLE_CHILD);
        assert.ok(live.pid);
        const original = JSON.stringify({ pid: live.pid, bootTime: currentBootTime(), token: "other" });
        await writeFile(join(env.stateDir, "owner.lock"), original);

        await assert.rejects(acquireOwnership(env.stateDir), (error: unknown) => {
            assert.ok(error instanceof OwnershipRefusedError);
            assert.equal(error.ownerPid, live.pid);
            assert.equal(error.stateDir, env.stateDir);
            assert.ok(error.message.includes(env.stateDir));
            assert.ok(error.message.includes(String(live.pid)));
            return true;
        });
        assert.equal(await readFile(join(env.stateDir, "owner.lock"), "utf8"), original);
    });

    it("takes over when the lock names a process that has exited", async () => {
        const deadPid = await exitedChildPid();
        await writeFile(
            join(env.stateDir, "owner.lock"),
            JSON.stringify({ pid: deadPid, bootTime: currentBootTime(), token: "old" }),
        );

        await acquireOwnership(env.stateDir);

        assert.equal((await readLock(env.stateDir)).pid, process.pid);
    });

    it("takes over when the lock records another boot time even though its pid is alive", async () => {
        await writeFile(
            join(env.stateDir, "owner.lock"),
            JSON.stringify({ pid: process.pid, bootTime: currentBootTime() - 3_600_000, token: "old" }),
        );

        await acquireOwnership(env.stateDir);

        assert.notEqual((await readLock(env.stateDir)).token, "old");
    });

    it("takes over when the lock holds this process's own pid and the current boot time", async () => {
        await writeFile(
            join(env.stateDir, "owner.lock"),
            JSON.stringify({ pid: process.pid, bootTime: currentBootTime(), token: "old" }),
        );

        await acquireOwnership(env.stateDir);

        assert.notEqual((await readLock(env.stateDir)).token, "old");
    });

    it("takes over when the lock content cannot be parsed", async () => {
        await writeFile(join(env.stateDir, "owner.lock"), "not json");

        await acquireOwnership(env.stateDir);

        assert.equal((await readLock(env.stateDir)).pid, process.pid);
    });

    it("grants ownership to exactly one of two processes racing for a stale lock", async () => {
        const deadPid = await exitedChildPid();
        await writeFile(
            join(env.stateDir, "owner.lock"),
            JSON.stringify({ pid: deadPid, bootTime: currentBootTime(), token: "old" }),
        );
        const racers = [
            await trackedChild(ACQUIRING_CHILD, [env.stateDir]),
            await trackedChild(ACQUIRING_CHILD, [env.stateDir]),
        ];

        const answers = racers.map(nextLine);
        for (const racer of racers) racer.stdin?.write("go\n");
        const results = await Promise.all(answers);

        assert.deepEqual([...results].sort(), ["granted", "refused"]);
        const winner = racers[results.indexOf("granted")];
        assert.equal((await readLock(env.stateDir)).pid, winner.pid);
    });
});

describe("release", () => {
    let env: HermeticEnv;

    beforeEach(async () => {
        env = await createHermeticEnv();
    });

    afterEach(async () => {
        await env.dispose();
    });

    it("removes the lock file while it still holds this daemon's token", async () => {
        const handle = await acquireOwnership(env.stateDir);

        await handle.release();

        await assert.rejects(stat(join(env.stateDir, "owner.lock")), { code: "ENOENT" });
    });

    it("leaves the lock file alone when another daemon's token is in it", async () => {
        const handle = await acquireOwnership(env.stateDir);
        const foreign = JSON.stringify({ pid: process.pid, bootTime: currentBootTime(), token: "someone-else" });
        await writeFile(join(env.stateDir, "owner.lock"), foreign);

        await handle.release();

        assert.equal(await readFile(join(env.stateDir, "owner.lock"), "utf8"), foreign);
    });

    it("does nothing when the lock file is already gone", async () => {
        const handle = await acquireOwnership(env.stateDir);
        await handle.release();

        await handle.release();
    });
});

describe("acquireInstallLock", () => {
    let env: HermeticEnv;
    let children: ChildProcess[];

    beforeEach(async () => {
        env = await createHermeticEnv();
        children = [];
    });

    afterEach(async () => {
        await Promise.all(children.filter((child) => child.exitCode === null).map(stopChild));
        await env.dispose();
    });

    async function readInstallLock(): Promise<LockContent & { command: string }> {
        return JSON.parse(await readFile(join(env.stateDir, "install.lock"), "utf8"));
    }

    it("writes install.lock with this pid, the boot time, a token and the command name", async () => {
        await acquireInstallLock(env.stateDir, "install");

        const lock = await readInstallLock();
        assert.equal(lock.pid, process.pid);
        assert.ok(Math.abs(lock.bootTime - currentBootTime()) <= BOOT_TIME_TOLERANCE_MS);
        assert.ok(lock.token.length > 0);
        assert.equal(lock.command, "install");
        assert.equal((await stat(join(env.stateDir, "install.lock"))).mode & 0o777, 0o600);
    });

    it("refuses with the command named in the lock while a live process holds it", async () => {
        const holder = await startChild(IDLE_CHILD);
        children.push(holder);
        assert.ok(holder.pid);
        await writeFile(
            join(env.stateDir, "install.lock"),
            JSON.stringify({ pid: holder.pid, bootTime: currentBootTime(), token: "other", command: "update" }),
        );

        await assert.rejects(acquireInstallLock(env.stateDir, "install"), (error: unknown) => {
            assert.ok(error instanceof InstallLockRefusedError);
            assert.equal(error.commandName, "update");
            assert.equal(error.ownerPid, holder.pid);
            assert.equal(error.message, `update is running (pid ${holder.pid})`);
            return true;
        });
    });

    it("succeeds after the holder released the lock", async () => {
        const handle = await acquireInstallLock(env.stateDir, "install");
        await handle.release();
        await assert.rejects(stat(join(env.stateDir, "install.lock")), { code: "ENOENT" });

        await acquireInstallLock(env.stateDir, "uninstall");

        assert.equal((await readInstallLock()).command, "uninstall");
    });

    it("takes over when the lock holds this process's own pid and the current boot time", async () => {
        await writeFile(
            join(env.stateDir, "install.lock"),
            JSON.stringify({ pid: process.pid, bootTime: currentBootTime(), token: "old", command: "update" }),
        );

        await acquireInstallLock(env.stateDir, "install");

        const lock = await readInstallLock();
        assert.notEqual(lock.token, "old");
        assert.equal(lock.command, "install");
    });

    it("takes over when the lock names a process that has exited", async () => {
        await writeFile(
            join(env.stateDir, "install.lock"),
            JSON.stringify({ pid: await exitedChildPid(), bootTime: currentBootTime(), token: "old", command: "x" }),
        );

        await acquireInstallLock(env.stateDir, "install");

        assert.equal((await readInstallLock()).pid, process.pid);
    });

    it("does not touch owner.lock", async () => {
        await acquireInstallLock(env.stateDir, "install");

        await assert.rejects(stat(join(env.stateDir, "owner.lock")), { code: "ENOENT" });
    });
});

describe("readOwnerLock", () => {
    let env: HermeticEnv;
    let child: ChildProcess | undefined;

    beforeEach(async () => {
        env = await createHermeticEnv();
        child = undefined;
    });

    afterEach(async () => {
        if (child && child.exitCode === null) await stopChild(child);
        await env.dispose();
    });

    it("returns the pid and token while a live process holds the owner lock", async () => {
        child = await startChild(IDLE_CHILD);
        await writeFile(
            join(env.stateDir, "owner.lock"),
            JSON.stringify({ pid: child.pid, bootTime: currentBootTime(), token: "live-token" }),
        );

        assert.deepEqual(await readOwnerLock(env.stateDir), { pid: child.pid, token: "live-token" });
    });

    it("returns undefined when there is no owner lock", async () => {
        assert.equal(await readOwnerLock(env.stateDir), undefined);
    });

    it("returns undefined when the owner lock names a process that has exited", async () => {
        await writeFile(
            join(env.stateDir, "owner.lock"),
            JSON.stringify({ pid: await exitedChildPid(), bootTime: currentBootTime(), token: "old" }),
        );

        assert.equal(await readOwnerLock(env.stateDir), undefined);
    });

    it("leaves the stale owner lock in place", async () => {
        const stale = JSON.stringify({ pid: await exitedChildPid(), bootTime: currentBootTime(), token: "old" });
        await writeFile(join(env.stateDir, "owner.lock"), stale);

        await readOwnerLock(env.stateDir);

        assert.equal(await readFile(join(env.stateDir, "owner.lock"), "utf8"), stale);
    });
});
