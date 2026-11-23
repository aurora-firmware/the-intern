import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runBob, spawnBob } from "../support/bob_process.ts";
import { exitWithin } from "../support/exit_deadline.ts";
import { createHermeticEnv } from "../support/hermetic_env.ts";
import { hasScript, runInPty } from "../support/pty.ts";

const HANGING_PROGRAM = "setInterval(() => {}, 1000)";
const QUICK_PROGRAM = "process.exit(7)";

function start(program: string) {
    return spawn(process.execPath, ["-e", program], { stdio: "ignore" });
}

describe("exitWithin", () => {
    it("resolves with the exit status of a child that exits in time", async () => {
        const child = start(QUICK_PROGRAM);

        assert.equal(await exitWithin(child, "quick child", 20_000), 7);
    });

    it("rejects naming the child and kills it when it has not exited by the deadline", async () => {
        const child = start(HANGING_PROGRAM);

        await assert.rejects(exitWithin(child, "hanging child", 100), /hanging child did not exit within 100 ms/);

        await new Promise((resolve) =>
            child.exitCode === null && child.signalCode === null ? child.once("close", resolve) : resolve(undefined),
        );
        assert.equal(child.signalCode, "SIGKILL");
    });
});

const SHORT_DEADLINE_MS = 300;
const servers: Server[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

/** A runtime directory whose socket accepts connections and never answers, so any `bob` command that calls waits. */
async function silentDaemon() {
    const env = await createHermeticEnv();
    const server = createServer((socket) => socket.on("error", () => {}));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(env.runtimeDir, "bob.sock"), resolve));
    return env;
}

describe("the bob process helpers", () => {
    it("runBob rejects when bob does not exit by the deadline", async () => {
        const env = await silentDaemon();

        await assert.rejects(
            runBob(["jobs", "list"], { runtimeDir: env.runtimeDir, env: env.env, deadlineMs: SHORT_DEADLINE_MS }),
            /bob jobs list did not exit within 300 ms/,
        );
        await env.dispose();
    });

    it("spawnBob rejects its exit promise when bob does not exit by the deadline", async () => {
        const env = await silentDaemon();
        const child = spawnBob(["jobs", "list"], {
            runtimeDir: env.runtimeDir,
            env: env.env,
            deadlineMs: SHORT_DEADLINE_MS,
        });

        await assert.rejects(child.exited, /bob jobs list did not exit within 300 ms/);
        await env.dispose();
    });

    it("runInPty rejects its exit promise when bob does not exit by the deadline", { skip: !hasScript() }, async () => {
        const env = await silentDaemon();
        const session = runInPty(["jobs", "list"], { runtimeDir: env.runtimeDir, deadlineMs: SHORT_DEADLINE_MS });

        await assert.rejects(session.exited, /bob jobs list did not exit within 300 ms/);
        await env.dispose();
    });
});
