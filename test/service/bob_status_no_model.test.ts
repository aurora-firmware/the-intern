/**
 * `bob status` and the default model (S-005 REQ-008, AC-008.2): while `daemon.status` has `noDefaultModel`, `bob status`
 * prints its message; once the field is null it prints none of it; `--json` prints the answer unchanged.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 50;
const TEST_TIMEOUT_MS = scaled(90_000);
const FAKE_DEFAULT = JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" });

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startWith(settings: string) {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.piAgentDir, "settings.json"), settings);
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const statusOf = async (daemon: DaemonProcess): Promise<DaemonStatus> =>
    (await daemon.invoke("daemon.status", {})) as DaemonStatus;

async function untilNoDefaultModelIsNull(daemon: DaemonProcess): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while ((await statusOf(daemon)).noDefaultModel !== null) {
        if (Date.now() > deadline) assert.fail("timed out waiting for the daemon to notice the default model");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

describe("bob status with no default model", { timeout: TEST_TIMEOUT_MS }, () => {
    it("prints the message of noDefaultModel and exits 0", async () => {
        const { env, daemon } = await startWith("{}");
        const { noDefaultModel } = await statusOf(daemon);
        assert.ok(noDefaultModel);

        const result = await runBob(["status"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(noDefaultModel.message), result.stdout);
    });

    it("prints the daemon.status answer unchanged with --json", async () => {
        const { env, daemon } = await startWith("{}");

        const result = await runBob(["status", "--json"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        const printed = JSON.parse(result.stdout) as DaemonStatus;
        assert.deepEqual(printed.noDefaultModel, (await statusOf(daemon)).noDefaultModel);
        assert.notEqual(printed.noDefaultModel, null);
    });

    it("prints no notice once the folder names the fake model, with no restart", async () => {
        const { env, daemon } = await startWith("{}");
        const { noDefaultModel } = await statusOf(daemon);
        assert.ok(noDefaultModel);

        await writeFile(join(env.piAgentDir, "settings.json"), FAKE_DEFAULT);
        await untilNoDefaultModelIsNull(daemon);
        const result = await runBob(["status"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        assert.ok(!result.stdout.includes(noDefaultModel.message), result.stdout);
        assert.ok(!result.stdout.toLowerCase().includes("no default model"), result.stdout);
    });
});
