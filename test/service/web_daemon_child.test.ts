/**
 * The test daemon child with a network listener (T-209): the start options and the fake model scripts the browser
 * tests drive.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type DaemonProcess,
    freeLoopbackPort,
    type StartDaemonOptions,
    startDaemon,
} from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 20;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const HOLD_CHECK_MS = 500;
const ENTRIES_LIMIT = 200;
const INVOKED_COUNT = 8;
const ONE_MIB = 1024 * 1024;
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
const LOOPBACK = "127.0.0.1";

type Job = {
    id: string;
    status: string;
    blockedReason?: string;
    leadConversation?: string;
    request: { origin: { kind: string; frontDesk?: string } };
};
type Listing = { id: string; status: string; isLead: boolean; isFrontDesk: boolean };
type Entry = { kind: string; data: unknown };
type NetworkState = { hasStarted: boolean };

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

async function start(options: Omit<StartDaemonOptions, "hermetic">, env?: HermeticEnv): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env ?? (await newEnv()), ...options });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jobOf = async (daemon: DaemonProcess, job: string) => (await daemon.invoke("jobs.get", { job })) as Job;
const conversationsOf = async (daemon: DaemonProcess, jobId: string) =>
    (await daemon.invoke("conversations.list", { jobId })) as Listing[];

function statusOfUi(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        get({ host: LOOPBACK, port, path: "/ui/" }, (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
        }).on("error", reject);
    });
}

describe("the network listener options", () => {
    it("answers GET /ui/ on the port networkPort gives", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = await start({ networkListener: true });

        const port = await daemon.networkPort();

        assert.equal(await statusOfUi(port), 200);
    });

    it("listens on fixedPort across a restart", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await newEnv();
        const fixedPort = await freeLoopbackPort();
        const first = await start({ networkListener: true, fixedPort }, env);
        assert.equal(await first.networkPort(), fixedPort);
        first.kill9();
        await first.exited;

        const second = await start({ networkListener: true, fixedPort }, env);

        assert.equal(await second.networkPort(), fixedPort);
        assert.equal(await statusOfUi(fixedPort), 200);
        const config = await readFile(join(env.configDir, "config.toml"), "utf8");
        assert.equal(config.match(/\[network\]/g)?.length, 1, "the restart did not repeat the section");
    });

    it("opens no network port without networkListener", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = await start({});

        await assert.rejects(daemon.networkPort(), /no network/i);
    });

    it("opens no port with omitNetworkSection, and the component still runs its start hook", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = await start({ networkListener: true, omitNetworkSection: true });

        await assert.rejects(daemon.networkPort(), /no network/i);
        const state = (await daemon.invoke("test.networkListener", {})) as NetworkState;
        assert.equal(state.hasStarted, true);
    });
});

describe("the block-with-reason script", () => {
    it("blocks the job with the reason its text names, then holds the lead after an answer until releaseRuns", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = await start({ script: "block-with-reason" });
        const created = (await daemon.invoke("jobs.create", { text: "which colour" })) as Job;

        await untilTrue(async () => (await jobOf(daemon, created.id)).status === "blocked", "the job to be Blocked");
        assert.ok((await jobOf(daemon, created.id)).blockedReason?.includes("which colour"));
        await daemon.invoke("jobs.resume", { job: created.id, text: "blue" });
        await pause(HOLD_CHECK_MS);
        assert.notEqual((await jobOf(daemon, created.id)).status, "done", "the lead is held");
        assert.notEqual((await jobOf(daemon, created.id)).status, "blocked", "the lead did not block again");
        daemon.releaseRuns();

        await untilTrue(async () => (await jobOf(daemon, created.id)).status === "done", "the job to be Done");
    });
});

describe("the invoke-many script", () => {
    it("answers the lead's first turn and holds eight invoked conversations running until releaseRuns", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = await start({ script: "invoke-many", workerThreads: INVOKED_COUNT + 2 });
        const created = (await daemon.invoke("jobs.create", { text: "fan out" })) as Job;

        const isInvokedRunning = async () =>
            (await conversationsOf(daemon, created.id)).filter(({ isLead, status }) => !isLead && status === "running");
        await untilTrue(
            async () => (await isInvokedRunning()).length === INVOKED_COUNT,
            "eight running invoked agents",
        );
        await pause(HOLD_CHECK_MS);
        assert.equal((await isInvokedRunning()).length, INVOKED_COUNT, "they stay running");
        daemon.releaseRuns();

        await untilTrue(async () => (await isInvokedRunning()).length === 0, "the invoked agents to finish");
    });
});

describe("the long-output and desk-create-job scripts", () => {
    it("returns a 1 MiB tool result untruncated", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = await start({ script: "long-output" });
        const created = (await daemon.invoke("jobs.create", { text: "make output" })) as Job;
        const leadId = created.leadConversation as string;

        const toolResultLength = async () => {
            const { entries } = (await daemon.invoke("conversations.entries", {
                conversationId: leadId,
                limit: ENTRIES_LIMIT,
            })) as { entries: Entry[] };
            const result = entries.find((entry) => entry.kind === "pi.tool-result");
            const [message] = (result?.data ?? []) as { content: { text: string }[] }[];
            return message?.content.map(({ text }) => text).join("").length ?? 0;
        };
        await untilTrue(async () => (await toolResultLength()) > 0, "the tool result in the lead's transcript");
        assert.equal(await toolResultLength(), ONE_MIB);
    });

    it("makes the front desk create a job with origin front_desk", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = await start({ script: "desk-create-job" });
        const desk = (await daemon.invoke("desk.get", {})) as { conversationId: string };

        await daemon.invoke("conversations.submit", {
            conversationId: desk.conversationId,
            content: "create job paint the fence",
            requestId: "web-daemon-child-1",
        });

        const listed = async () => (await daemon.invoke("jobs.list", {})) as { jobs: Job[] };
        await untilTrue(async () => (await listed()).jobs.length === 1, "the front desk's job");
        const [job] = (await listed()).jobs;
        assert.equal(job?.request.origin.frontDesk, desk.conversationId, "the front desk is in the origin details");
    });
});
