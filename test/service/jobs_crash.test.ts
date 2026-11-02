/**
 * The repair rules of S-004 REQ-018 and the turn-end check across a real `kill -9`: the child daemon kills itself at a
 * write point of the Jobs component (`jobCrashAt`), a second child starts on the same instance, and the first calls
 * after `ready` see the state the repair left, since startup repairs jobs before the daemon is ready.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { WritePoint } from "../../src/jobs/jobs_component.ts";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const SLOW_DELAY_MS = 2_000;
const LIMIT = 200;
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
const REASON = "which build is failing?";
const ANSWER = "the answer that reached the lead";
const DAEMON_AUTHOR = { kind: "daemon" };

type Entry = { kind: string; data: unknown };
type Listing = { id: string; jobId: string | null; isLead: boolean; status: string };
type JobView = { id: string; status: string; blockedReason?: string; leadConversation?: string };
type HistoryEntry = { field: string; old: unknown; new: unknown; author: unknown };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    return env;
}

/** The turn-end rule is on only for the tests about it; elsewhere a lead's stop would block its job. */
function start(env: HermeticEnv, script: FakeScript, jobCrashAt?: WritePoint, turnEndRule = false): DaemonProcess {
    const daemon = startDaemon({
        hermetic: env,
        script,
        delayMs: SLOW_DELAY_MS,
        turnEndRule,
        ...(jobCrashAt !== undefined && { jobCrashAt }),
    });
    daemons.push(daemon);
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

const listingOf = async (daemon: DaemonProcess, conversationId: string) =>
    (await daemon.invoke("conversations.get", { conversationId })) as Listing;

const conversationsOf = async (daemon: DaemonProcess, jobId: string) =>
    (await daemon.invoke("conversations.list", { jobId })) as Listing[];

const jobOf = async (daemon: DaemonProcess, job: string) => (await daemon.invoke("jobs.get", { job })) as JobView;

const historyOf = async (daemon: DaemonProcess, job: string) =>
    ((await daemon.invoke("jobs.history.list", { job, limit: LIMIT })) as { entries: HistoryEntry[] }).entries;

/** The rules of the job's `repair` history entries, each of which the daemon must have authored. */
async function repairsOf(daemon: DaemonProcess, job: string): Promise<number[]> {
    const repairs = (await historyOf(daemon, job)).filter((entry) => entry.field === "repair");
    for (const repair of repairs) assert.deepEqual(repair.author, DAEMON_AUTHOR, "the daemon authors each repair");
    return repairs.map((repair) => (repair.new as { rule: number }).rule);
}

const entriesOf = async (daemon: DaemonProcess, conversationId: string) =>
    (
        (await daemon.invoke("conversations.entries", { conversationId, limit: LIMIT })) as {
            entries: Entry[];
        }
    ).entries;

const userInputsWith = async (daemon: DaemonProcess, conversationId: string, text: string) =>
    (await entriesOf(daemon, conversationId)).filter(
        (entry) => entry.kind === "pi.user" && JSON.stringify(entry.data).includes(text),
    ).length;

/** The fake model echoes each input it takes, so one echo is one input the lead took. */
const echoesOf = async (daemon: DaemonProcess, conversationId: string, text: string) =>
    (await entriesOf(daemon, conversationId)).filter(
        (entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes(`echo: ${text}`),
    ).length;

const untilStatus = (daemon: DaemonProcess, conversationId: string, status: string) =>
    untilTrue(async () => (await listingOf(daemon, conversationId)).status === status, `the lead to be ${status}`);

async function createJob(daemon: DaemonProcess, text: string, idempotencyKey?: string): Promise<JobView> {
    const job = (await daemon.invoke("jobs.create", {
        text,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
    })) as JobView;
    assert.ok(job.leadConversation, "the created job names its lead conversation");
    return job;
}

/** Waits for the kill the switch sends, so the next daemon starts on a dead one's state. */
async function untilKilled(daemon: DaemonProcess): Promise<void> {
    assert.equal((await daemon.exited).signal, "SIGKILL");
}

async function untilLeadAnswered(daemon: DaemonProcess, leadId: string): Promise<void> {
    await untilTrue(
        async () => (await entriesOf(daemon, leadId)).some((entry) => entry.kind === "pi.assistant"),
        "the lead's answer",
    );
    await untilStatus(daemon, leadId, "idle");
}

/** Sends the answer to the lead the way a team member's reply does; the request id keeps it from being a resume. */
const answerLead = (daemon: DaemonProcess, conversationId: string) =>
    daemon
        .invoke("conversations.submit", { conversationId, content: ANSWER, requestId: "answer-1", busyMode: "followUp" })
        .catch(() => undefined);

describe("kill -9 after the job write and before its lead starts", () => {
    it("starts one lead that takes the first input once, and a repeated create returns the job", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "echo", "job-created");
        await first.ready;
        await assert.rejects(createJob(first, "crash at creation", "key-1"));
        await untilKilled(first);

        const second = start(env, "echo");
        await second.ready;

        const [job] = ((await second.invoke("jobs.list", {})) as { jobs: JobView[] }).jobs;
        assert.ok(job);
        assert.equal(job.status, "in_progress");
        const leads = (await conversationsOf(second, job.id)).filter((conversation) => conversation.isLead);
        assert.equal(leads.length, 1);
        assert.deepEqual(await repairsOf(second, job.id), [1]);
        const leadId = (leads[0] as Listing).id;
        await untilLeadAnswered(second, leadId);
        assert.equal(await userInputsWith(second, leadId, "crash at creation"), 1);

        const repeated = await createJob(second, "crash at creation", "key-1");

        assert.equal(repeated.id, job.id);
        assert.equal(repeated.leadConversation, leadId);
        assert.equal((await conversationsOf(second, job.id)).length, 1);
        assert.equal(await userInputsWith(second, leadId, "crash at creation"), 1);
        assert.deepEqual(await repairsOf(second, job.id), [1]);
    });
});

describe("kill -9 after the block write and before the park", () => {
    it("parks the lead for an answer at the next start", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "echo", "job-blocked");
        await first.ready;
        const job = await createJob(first, "block me");
        const leadId = job.leadConversation as string;
        await untilLeadAnswered(first, leadId);
        const blocking = first.invoke("test.blockJob", { job: job.id, reason: REASON }).catch(() => undefined);
        await untilKilled(first);
        await blocking;

        const second = start(env, "echo");
        await second.ready;

        const stored = await jobOf(second, job.id);
        assert.equal(stored.status, "blocked");
        assert.equal(stored.blockedReason, REASON);
        assert.equal((await listingOf(second, leadId)).status, "parked");
        assert.deepEqual(await repairsOf(second, job.id), [2]);
    });
});

describe("kill -9 after input reached the lead of a Blocked job and before the resume", () => {
    it("resumes the job and lets the lead take input that was queued for its running run", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "slow", "lead-input");
        await first.ready;
        const job = await createJob(first, "block me while I run");
        const leadId = job.leadConversation as string;
        await untilStatus(first, leadId, "running");
        await first.invoke("test.blockJob", { job: job.id, reason: REASON });
        const answering = answerLead(first, leadId);
        await untilKilled(first);
        await answering;

        const second = start(env, "slow");
        await second.ready;

        const stored = await jobOf(second, job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        assert.notEqual((await listingOf(second, leadId)).status, "parked");
        assert.deepEqual(await repairsOf(second, job.id), [3]);
        await untilTrue(async () => (await echoesOf(second, leadId, ANSWER)) === 1, "the lead to take the answer");
    });

    it("resumes the job and unparks an idle lead that took the answer before the kill", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "echo", "lead-input");
        await first.ready;
        const job = await createJob(first, "block me while idle");
        const leadId = job.leadConversation as string;
        await untilLeadAnswered(first, leadId);
        await first.invoke("test.blockJob", { job: job.id, reason: REASON });
        assert.equal((await listingOf(first, leadId)).status, "parked");
        const answering = answerLead(first, leadId);
        await untilKilled(first);
        await answering;

        const second = start(env, "echo");
        await second.ready;

        const stored = await jobOf(second, job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        assert.notEqual((await listingOf(second, leadId)).status, "parked");
        assert.deepEqual(await repairsOf(second, job.id), [3]);
        assert.equal(await echoesOf(second, leadId, ANSWER), 1, "the lead took the answer once");
    });
});

describe("kill -9 after a complete or cancel write and before the aborts", () => {
    it("leaves no parked lead after a cancel", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "echo", "job-cancelled");
        await first.ready;
        const job = await createJob(first, "cancel me while blocked");
        const leadId = job.leadConversation as string;
        await untilLeadAnswered(first, leadId);
        await first.invoke("test.blockJob", { job: job.id, reason: REASON });
        assert.equal((await listingOf(first, leadId)).status, "parked");
        const cancelling = first
            .invoke("jobs.cancel", { job: job.id, justification: "no longer needed" })
            .catch(() => undefined);
        await untilKilled(first);
        await cancelling;

        const second = start(env, "echo");
        await second.ready;

        assert.equal((await jobOf(second, job.id)).status, "done");
        assert.equal((await listingOf(second, leadId)).status, "idle");
        assert.deepEqual(await repairsOf(second, job.id), [4]);
    });

    it("leaves no conversation running or parked after a complete", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "invoke-parked", "job-completed");
        await first.ready;
        const job = await createJob(first, "complete me with work in flight");
        await untilTrue(async () => (await conversationsOf(first, job.id)).length === 3, "both invoked conversations");
        await first.invoke("jobs.update", { job: job.id, definitionOfDone: "the work is stopped" });
        const completing = first
            .invoke("jobs.complete", { job: job.id, justification: "done early" })
            .catch(() => undefined);
        await untilKilled(first);
        await completing;

        const second = start(env, "invoke-parked");
        await second.ready;

        assert.equal((await jobOf(second, job.id)).status, "done");
        const conversations = await conversationsOf(second, job.id);
        assert.equal(conversations.length, 3);
        for (const conversation of conversations) assert.equal(conversation.status, "idle", conversation.id);
        assert.deepEqual(await repairsOf(second, job.id), [4]);
    });
});

describe("kill -9 as a lead's turn ends with its job In progress", () => {
    it("blocks the job at the next start when it has no definition of done", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "echo", "turn-ended", true);
        await first.ready;
        const job = await createJob(first, "end the turn");
        await untilKilled(first);

        const second = start(env, "echo", undefined, true);
        await second.ready;

        const stored = await jobOf(second, job.id);
        assert.equal(stored.status, "blocked");
        assert.ok(stored.blockedReason);
        assert.equal((await listingOf(second, job.leadConversation as string)).status, "parked");
        const blocks = (await historyOf(second, job.id)).filter((entry) => entry.new === "blocked");
        assert.deepEqual(
            blocks.map((entry) => entry.author),
            [DAEMON_AUTHOR],
        );
    });

    it("reminds the lead once at the next start when the job has a definition of done", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "slow", "turn-ended", true);
        await first.ready;
        const job = await createJob(first, "end the turn with a definition of done");
        const leadId = job.leadConversation as string;
        await untilStatus(first, leadId, "running");
        await first.invoke("jobs.update", { job: job.id, definitionOfDone: "the report is filed" });
        await untilKilled(first);

        const second = start(env, "slow", undefined, true);
        await second.ready;

        assert.equal((await jobOf(second, job.id)).status, "in_progress");
        await untilTrue(async () => (await echoesOf(second, leadId, REMINDER_TEXT)) === 1, "the reminder");
        assert.deepEqual(await repairsOf(second, job.id), []);
    });
});
