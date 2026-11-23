import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const JOB_COUNT = 100;
const LIST_TARGET_MS = 500;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<{ env: HermeticEnv; daemon: DaemonProcess }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

describe("bob reference timings", () => {
    it("reports bob jobs list over 100 jobs beside its half-second reference", async (t) => {
        const { env, daemon } = await readyDaemon();
        for (let i = 0; i < JOB_COUNT; i++) await daemon.invoke("jobs.create", { text: `seeded job ${i}` });

        const began = performance.now();
        const result = await runBob(["jobs", "list", "--limit", String(JOB_COUNT)], {
            runtimeDir: env.runtimeDir,
            env: env.env,
        });
        const tookMs = performance.now() - began;

        // The reference is not an acceptance threshold (S-005 REQ-016): a miss is reported here, never failed.
        t.diagnostic(`bob jobs list over ${JOB_COUNT} jobs: ${tookMs.toFixed(1)} ms (reference ${LIST_TARGET_MS} ms)`);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim().split("\n").length, JOB_COUNT, result.stdout);
    });
});
