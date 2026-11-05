import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const FIXTURE = join(import.meta.dirname, "..", "support", "orphan_fixture.ts");
const START_TIMEOUT_MS = 30_000;
const GONE_TIMEOUT_MS = 10_000;
const POLL_MS = 20;

type Started = { pid: number; root: string };

async function commandLine(pid: number): Promise<string> {
    try {
        return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
    } catch {
        return "";
    }
}

/** True while the process `pid` exists and is still the one started under `root`; a reused pid does not count. */
async function isDaemonAlive(started: Started): Promise<boolean> {
    return (await commandLine(started.pid)).includes(started.root);
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return condition();
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

/** Starts the fixture, waits for its ready daemon, kills the fixture with SIGKILL, and returns the daemon it reported. */
async function killTestProcessAfterReady(mode: "serve" | "forked"): Promise<Started> {
    const fixture = spawn(process.execPath, [FIXTURE, mode], { stdio: ["ignore", "pipe", "inherit"] });
    const started = await new Promise<Started>((resolve, reject) => {
        const timer = setTimeout(() => {
            fixture.kill("SIGKILL");
            reject(new Error(`the ${mode} fixture did not report a ready daemon`));
        }, START_TIMEOUT_MS);
        fixture.once("exit", () => reject(new Error(`the ${mode} fixture exited before its daemon was ready`)));
        fixture.stdout.once("data", (chunk) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(chunk)) as Started);
        });
    });
    fixture.kill("SIGKILL");
    await new Promise((resolve) => fixture.once("exit", resolve));
    return started;
}

/** Stops a daemon the code under test failed to stop, so a red run leaves nothing behind. */
async function stopLeftover(started: Started): Promise<void> {
    if (await isDaemonAlive(started)) process.kill(started.pid, "SIGKILL");
}

for (const mode of ["serve", "forked"] as const) {
    describe(`a test process killed while its ${mode} daemon runs`, () => {
        it("leaves no daemon and no hermetic directory behind", async () => {
            const started = await killTestProcessAfterReady(mode);
            try {
                const isGone = await waitUntil(async () => !(await isDaemonAlive(started)), GONE_TIMEOUT_MS);
                assert.equal(isGone, true, `daemon ${started.pid} of ${started.root} outlived its test process`);
                const isRootRemoved = await waitUntil(async () => !(await exists(started.root)), GONE_TIMEOUT_MS);
                assert.equal(isRootRemoved, true, `${started.root} was not removed`);
            } finally {
                await stopLeftover(started);
            }
        });
    });
}
