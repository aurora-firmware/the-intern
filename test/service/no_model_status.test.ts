/**
 * `daemon.status` and the default model (S-002 REQ-003, AC-003.3; ADR-014): the daemon reports `noDefaultModel` while
 * pi agent's settings name no default, and follows `settings.json` in its isolated pi agent folder both ways without a
 * restart. The model runtime reads the folder again every 10 seconds, so each test waits for the state it expects.
 */
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 50;
const FAKE_DEFAULT = JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" });

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.signal("SIGTERM");
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

async function untilStatus(daemon: DaemonProcess, what: string, isReached: (status: DaemonStatus) => boolean) {
    const deadline = Date.now() + WAIT_MS;
    while (!isReached(await statusOf(daemon))) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

describe("daemon.status noDefaultModel", () => {
    it("names the pi agent folder and how to sign in while the settings name no default model", async () => {
        const { env, daemon } = await startWith("{}");

        const { noDefaultModel } = await statusOf(daemon);

        assert.equal(noDefaultModel?.piAgentDir, env.piAgentDir);
        for (const part of ["no default model", "`pi`", "/login", "/model"]) {
            assert.ok(noDefaultModel?.message.includes(part), `the message includes ${part}`);
        }
    });

    it("is null while the settings name a default model", async () => {
        const { daemon } = await startWith(FAKE_DEFAULT);

        assert.equal((await statusOf(daemon)).noDefaultModel, null);
    });

    it("turns null without a restart when the folder comes to name the fake model, and the folder holds only the test's file", async () => {
        const { env, daemon } = await startWith("{}");
        assert.notEqual((await statusOf(daemon)).noDefaultModel, null);

        await writeFile(join(env.piAgentDir, "settings.json"), FAKE_DEFAULT);
        await untilStatus(daemon, "no default model to clear", (status) => status.noDefaultModel === null);

        assert.deepEqual(await readdir(env.piAgentDir), ["settings.json"]);
    });

    it("reports no default model again when the folder stops naming one", async () => {
        const { env, daemon } = await startWith(FAKE_DEFAULT);
        assert.equal((await statusOf(daemon)).noDefaultModel, null);

        await writeFile(join(env.piAgentDir, "settings.json"), "{}");
        await untilStatus(daemon, "no default model to return", (status) => status.noDefaultModel !== null);

        assert.equal((await statusOf(daemon)).noDefaultModel?.piAgentDir, env.piAgentDir);
    });
});
