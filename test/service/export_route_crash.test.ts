import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, type StartDaemonOptions, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const NOTE_BYTES = 1_000_000;
const NOTE_COUNT = 24;
const EXIT_BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 20;
const WAIT_BOUND_MS = 20_000;
const LOOPBACK = "127.0.0.1";
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";

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
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    return env;
}

async function start(env: HermeticEnv, options: Omit<StartDaemonOptions, "hermetic">): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env, ...options });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

async function fillDatabase(daemon: DaemonProcess): Promise<void> {
    const job = (await daemon.invoke("jobs.create", { text: "do it" })) as { id: string };
    const text = "x".repeat(NOTE_BYTES);
    for (let i = 0; i < NOTE_COUNT; i++) await daemon.invoke("jobs.worklog.add", { job: job.id, text });
}

function entriesOf(env: HermeticEnv): Promise<string[]> {
    return readdir(join(env.stateDir, "exports")).catch(() => []);
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

/** Starts a download and returns its response once the headers are in, with its body left unread. */
function startDownload(port: number): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const call = request({ host: LOOPBACK, port, method: "GET", path: "/export" });
        call.once("error", reject);
        call.once("response", (response) => {
            response.pause();
            resolve(response);
        });
        call.end();
    });
}

/** A daemon with a network listener and a large database, and a download held in progress. */
async function holdDownload(env: HermeticEnv): Promise<{ daemon: DaemonProcess; response: IncomingMessage }> {
    const daemon = await start(env, { networkListener: true });
    await fillDatabase(daemon);
    const response = await startDownload(await daemon.networkPort());
    await untilTrue(async () => (await entriesOf(env)).length > 0, "the temporary copy");
    return { daemon, response };
}

async function killDuringDownload(env: HermeticEnv): Promise<void> {
    const { daemon } = await holdDownload(env);
    daemon.kill9();
    await daemon.exited;
}

describe("the export route when the daemon stops", () => {
    it("closes the held connection short and leaves no copy when SIGTERM comes, exiting 0 within the bound", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await newEnv();
        const { daemon, response } = await holdDownload(env);
        const ended = Promise.withResolvers<boolean>();
        response.once("end", () => ended.resolve(true));
        response.once("close", () => ended.resolve(false));
        response.once("error", () => undefined);

        daemon.signal("SIGTERM");

        const timeout = Symbol("timeout");
        const outcome = await Promise.race([
            daemon.exited,
            new Promise((resolve) => setTimeout(() => resolve(timeout), EXIT_BOUND_MS)),
        ]);
        assert.deepEqual(outcome, { code: 0, signal: null });
        response.resume();
        assert.equal(await ended.promise, false, "the response completed");
        assert.deepEqual(await entriesOf(env), []);
    });
});

describe("the export copy a killed daemon left", () => {
    it("is removed by the time the next start reports ready, with [network] set", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await newEnv();
        await killDuringDownload(env);
        assert.notDeepEqual(await entriesOf(env), [], "the kill left a copy");

        await start(env, { networkListener: true });

        assert.deepEqual(await entriesOf(env), []);
    });

    it("is removed by the time the next start reports ready, with the section removed", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await newEnv();
        await killDuringDownload(env);

        await start(env, { networkListener: true, omitNetworkSection: true });

        assert.deepEqual(await entriesOf(env), []);
    });

    it("is logged and does not stop the start when the exports folder cannot be read", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await newEnv();
        await mkdir(env.stateDir, { recursive: true });
        await writeFile(join(env.stateDir, "exports"), "a file where the folder should be");

        const daemon = await start(env, { networkListener: true });

        assert.match(daemon.stderr(), /export leftovers not removed/);
    });
});
