/**
 * The lead of a To do job that waits for a worker thread (S-004 REQ-005, REQ-008, AC-008.8). A team member's abort
 * that names it leaves the job To do with an idle lead, and input or the job's cancellation moves the job on.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 90_000;
const INPUT = "start on this";

type Job = { id: string; number: string };
type Page<Entry> = { entries: Entry[] };
type Entry = { kind: string };
type HistoryEntry = { field: string; new?: unknown; author: unknown };
type Rig = { daemon: DaemonProcess; held: Job; job: Job; lead: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const statusOf = async (daemon: DaemonProcess, conversationId: string) =>
    ((await daemon.invoke("conversations.get", { conversationId })) as { status: string }).status;

const jobOf = async (daemon: DaemonProcess, job: Job) =>
    (await daemon.invoke("jobs.get", { job: job.id })) as {
        status: string;
        resolution?: { kind: string };
        leadConversation: string;
    };

const historyOf = async (daemon: DaemonProcess, job: Job) =>
    ((await daemon.invoke("jobs.history.list", { job: job.id, limit: 100 })) as Page<HistoryEntry>).entries;

const entriesOf = async (daemon: DaemonProcess, conversationId: string) =>
    ((await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as Page<Entry>).entries;

/** One worker thread, held by the first job's lead, so the second job's lead waits for a thread. */
async function startWaitingLead(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "gated", workerThreads: 1, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    const held = (await daemon.invoke("jobs.create", { text: "holds the thread" })) as Job;
    const heldLead = (await jobOf(daemon, held)).leadConversation;
    await until("the first lead to run", async () => (await statusOf(daemon, heldLead)) === "running");
    const job = (await daemon.invoke("jobs.create", { text: "waits for a thread" })) as Job;
    const lead = (await jobOf(daemon, job)).leadConversation;
    await until(
        "the second lead to wait",
        async () => (await statusOf(daemon, lead)) === "waiting for a worker thread",
    );
    return { daemon, held, job, lead };
}

async function abortWaitingLead(rig: Rig) {
    const historyBefore = await historyOf(rig.daemon, rig.job);
    await rig.daemon.invoke("conversations.abort", { conversationId: rig.lead });
    await until("the lead to be idle", async () => (await statusOf(rig.daemon, rig.lead)) === "idle");
    return historyBefore;
}

describe("the lead of a To do job after a team member's abort", () => {
    it("leaves the job To do with an idle lead, no reminder and no history entry", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startWaitingLead();

        const historyBefore = await abortWaitingLead(rig);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        assert.equal((await jobOf(rig.daemon, rig.job)).status, "to_do");
        assert.equal(await statusOf(rig.daemon, rig.lead), "idle");
        const kinds = (await entriesOf(rig.daemon, rig.lead)).map((entry) => entry.kind);
        assert.equal(kinds.includes("intern.steer"), false, "no reminder");
        assert.equal(kinds.includes("pi.assistant"), false, "no answer");
        assert.deepEqual(await historyOf(rig.daemon, rig.job), historyBefore);
    });

    it("sets the job In progress with the lead running on input once a worker thread is free", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startWaitingLead();
        await abortWaitingLead(rig);
        rig.daemon.releaseRuns();
        await until("the thread to be free", async () => (await statusOf(rig.daemon, rig.lead)) === "idle");

        await rig.daemon.invoke("conversations.submit", {
            conversationId: rig.lead,
            content: INPUT,
            requestId: "start-1",
            busyMode: "followUp",
        });

        await until(
            "the job to be In progress",
            async () => (await jobOf(rig.daemon, rig.job)).status === "in_progress",
        );
        await until("the lead to take the input", async () =>
            JSON.stringify(await entriesOf(rig.daemon, rig.lead)).includes(INPUT),
        );
    });

    it("sets the job Done as cancelled when jobs.cancel names it with a justification", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startWaitingLead();
        await abortWaitingLead(rig);

        await rig.daemon.invoke("jobs.cancel", { job: rig.job.id, justification: "no longer needed" });

        const job = await jobOf(rig.daemon, rig.job);
        assert.equal(job.status, "done");
        assert.equal(job.resolution?.kind, "cancelled");
    });
});
