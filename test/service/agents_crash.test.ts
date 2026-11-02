import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const ENTRIES_LIMIT = 200;
const SLOW_DELAY_MS = 4_000;
const SEAT_RECORD_KIND = "intern.seat";
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
// The child daemon calls as a team member at the command line, so the job and its lead record that way in.
const RECORDED_ORIGIN = { kind: "request", wayIn: "command line" };
const IDEMPOTENCY_KEY = "crash-key";
const JOB_PROMPTS = ["job A", "job B"];

type Entry = { kind: string; data: unknown };
type SeatSummary = { role: string };
type SeatRecord = { previous: SeatSummary | null; next: SeatSummary };
type Listing = {
    id: string;
    jobId: string | null;
    isLead: boolean;
    seat: SeatSummary | null;
    origin: unknown;
    status: string;
    invokedBy?: string;
    depth: number;
};
type InvocationTree = { id: string; invoked: InvocationTree[] };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

// New seats resolve their model from the pi agent folder's default, which here is the fake model.
async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    return env;
}

function start(env: HermeticEnv, script: FakeScript): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script, delayMs: SLOW_DELAY_MS, turnEndRule: false });
    daemons.push(daemon);
    return daemon;
}

async function crash(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

type CreatedJob = { id: string; leadConversation?: string };

const createJobInput = (text: string, idempotencyKey?: string) => ({
    text,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
});

/** Creates a job with `jobs.create`; the daemon runs without the turn-end rule, so no stop blocks the job. */
async function createJob(daemon: DaemonProcess, text: string): Promise<{ jobId: string; leadId: string }> {
    const job = (await daemon.invoke("jobs.create", createJobInput(text))) as CreatedJob;
    assert.ok(job.leadConversation, "the created job names its lead conversation");
    return { jobId: job.id, leadId: job.leadConversation };
}

/** Sends a call without waiting for it. IPC messages are handled in order, so once the status answers, the call began. */
async function beginCall(daemon: DaemonProcess, op: string, input: unknown): Promise<Promise<unknown>> {
    const call = daemon.invoke(op, input).catch(() => undefined);
    await daemon.invoke("daemon.status", {});
    return call;
}

const entriesOf = async (daemon: DaemonProcess, conversationId: string): Promise<Entry[]> =>
    (
        (await daemon.invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
            entries: Entry[];
        }
    ).entries;

const listingOf = async (daemon: DaemonProcess, conversationId: string): Promise<Listing> =>
    (await daemon.invoke("conversations.get", { conversationId })) as Listing;

const conversationsOfJob = async (daemon: DaemonProcess, jobId: string): Promise<Listing[]> =>
    (await daemon.invoke("conversations.list", { jobId })) as Listing[];

const seatRecordsOf = async (daemon: DaemonProcess, conversationId: string): Promise<SeatRecord[]> =>
    (await entriesOf(daemon, conversationId))
        .filter((entry) => entry.kind === SEAT_RECORD_KIND)
        .map((entry) => entry.data as SeatRecord);

const mentions = (text: string) => (entry: Entry) =>
    entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes(text);
const takesInput = (text: string) => (entry: Entry) =>
    entry.kind === "pi.user" && JSON.stringify(entry.data).includes(text);

// The lead's first input is the job's number, its Request text and the lead's duty, so the echo holds the text inside.
const answers = (requestText: string) => (entry: Entry) =>
    entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes("echo: ") && mentions(requestText)(entry);

async function conversationsAcrossJobs(daemon: DaemonProcess, jobs: CreatedJob[]): Promise<Listing[]> {
    return (await Promise.all(jobs.map((job) => conversationsOfJob(daemon, job.id)))).flat();
}

async function untilRequestAnswered(daemon: DaemonProcess, conversationId: string, requestText: string): Promise<void> {
    await untilTrue(
        async () => (await entriesOf(daemon, conversationId)).some(answers(requestText)),
        `the answer to ${requestText}`,
    );
}

async function untilAnswered(daemon: DaemonProcess, conversationId: string, text: string): Promise<void> {
    await untilTrue(
        async () => (await entriesOf(daemon, conversationId)).some(mentions(`echo: ${text}`)),
        `the answer to ${text}`,
    );
}

async function untilIdle(daemon: DaemonProcess, conversationIds: string[]): Promise<void> {
    await untilTrue(async () => {
        for (const id of conversationIds) if ((await listingOf(daemon, id)).status !== "idle") return false;
        return true;
    }, "every conversation to be idle");
}

/** The seat of a conversation is the seat its latest record names, and each record continues from the one before. */
async function assertSeatMatchesRecords(daemon: DaemonProcess, conversationId: string): Promise<SeatRecord[]> {
    const records = await seatRecordsOf(daemon, conversationId);
    assert.ok(records.length >= 1, "a seated conversation has a seat record");
    assert.equal(records[0]?.previous, null, "the first record has no previous seat");
    for (let index = 1; index < records.length; index++) {
        assert.equal(records[index]?.previous?.role, records[index - 1]?.next.role, `record ${index} continues`);
    }
    assert.equal((await listingOf(daemon, conversationId)).seat?.role, records.at(-1)?.next.role);
    return records;
}

describe("kill -9 during a seat change", () => {
    it("shows the old seat without a new record or the new seat with its record", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "echo");
        await first.ready;
        const { jobId, leadId } = await createJob(first, "lead work");
        await untilRequestAnswered(first, leadId, "lead work");
        await untilIdle(first, [leadId]);
        const seatChange = await beginCall(first, "conversations.seat", { conversationId: leadId, role: "gp" });
        await crash(first);
        await seatChange;

        const second = start(env, "echo");
        await second.ready;

        const records = await assertSeatMatchesRecords(second, leadId);
        const seatRole = (await listingOf(second, leadId)).seat?.role;
        assert.deepEqual(
            [seatRole, records.length],
            seatRole === "bob" ? ["bob", 1] : ["gp", 2],
            "either the old seat with no new record or the new seat with its record",
        );
        const listing = await listingOf(second, leadId);
        assert.equal(listing.jobId, jobId);
        assert.equal(listing.isLead, true);
        assert.deepEqual(listing.origin, RECORDED_ORIGIN);
        assert.equal(listing.depth, 0);
    });
});

describe("kill -9 during a Clean handoff", () => {
    it("completes the handoff on resume or shows it not applied", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "handoff-clean");
        await first.ready;
        const { jobId, leadId } = await createJob(first, "first input");
        await untilTrue(async () => (await listingOf(first, leadId)).seat?.role === "gp", "the handoff to apply");
        await crash(first);

        const second = start(env, "handoff-clean");
        await second.ready;

        const records = await assertSeatMatchesRecords(second, leadId);
        const seatRole = (await listingOf(second, leadId)).seat?.role;
        assert.deepEqual([seatRole, records.length], ["gp", 2], "the handoff is applied with its record");
        assert.equal(records[1]?.previous?.role, "bob");
        await untilAnswered(second, leadId, "CLEAN-NOTE");
        await untilIdle(second, [leadId]);
        const entries = await entriesOf(second, leadId);
        assert.equal(entries.filter(mentions("echo: CLEAN-NOTE")).length, 1, "the new agent answered the note once");
        const listing = await listingOf(second, leadId);
        assert.equal(listing.jobId, jobId);
        assert.equal(listing.depth, 0);
    });
});

describe("kill -9 during an agent invocation", () => {
    it("shows each invoked conversation with its link and job and runs each job prompt once", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "invoke-parked");
        await first.ready;
        const { jobId, leadId } = await createJob(first, "lead work");
        await untilTrue(async () => (await conversationsOfJob(first, jobId)).length === 3, "both invocations");
        await crash(first);

        const second = start(env, "invoke-parked");
        await second.ready;

        const conversations = await conversationsOfJob(second, jobId);
        const invoked = conversations.filter((conversation) => conversation.id !== leadId);
        assert.equal(invoked.length, 2, "both invoked conversations survive");
        for (const conversation of invoked) {
            assert.equal(conversation.invokedBy, leadId);
            assert.equal(conversation.depth, 1);
            assert.deepEqual(conversation.origin, { kind: "invocation", conversationId: leadId });
            await assertSeatMatchesRecords(second, conversation.id);
        }
        const tree = (await second.invoke("conversations.invocations", { conversationId: leadId })) as InvocationTree;
        assert.deepEqual(
            tree.invoked.map((node) => node.id).toSorted(),
            invoked.map((conversation) => conversation.id).toSorted(),
        );
        for (const conversation of invoked) {
            await untilTrue(
                async () => (await entriesOf(second, conversation.id)).some((entry) => entry.kind === "pi.assistant"),
                `the answer of invoked conversation ${conversation.id}`,
            );
        }
        await untilIdle(
            second,
            conversations.map((conversation) => conversation.id),
        );
        assert.equal((await conversationsOfJob(second, jobId)).length, 3, "no conversation was added");
        for (const prompt of JOB_PROMPTS) {
            let promptInputs = 0;
            let promptAnswers = 0;
            for (const conversation of invoked) {
                const entries = await entriesOf(second, conversation.id);
                promptInputs += entries.filter(takesInput(prompt)).length;
                promptAnswers += entries.filter(mentions(`echo: ${prompt}`)).length;
            }
            assert.equal(promptInputs, 1, `${prompt} was given once`);
            assert.equal(promptAnswers, 1, `${prompt} was answered once`);
        }
    });
});

describe("kill -9 during jobs.create", () => {
    it("shows one job with one lead conversation that took the first input once after a repeated call", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "echo");
        await first.ready;
        const input = createJobInput("first input", IDEMPOTENCY_KEY);
        const interrupted = await beginCall(first, "jobs.create", input);
        await crash(first);
        await interrupted;

        const second = start(env, "echo");
        await second.ready;

        const jobsBefore = ((await second.invoke("jobs.list", {})) as { jobs: CreatedJob[] }).jobs;
        assert.ok(jobsBefore.length <= 1, "at most one job exists");
        for (const survivor of await conversationsAcrossJobs(second, jobsBefore)) {
            assert.equal(survivor.isLead, true);
            assert.deepEqual(survivor.origin, RECORDED_ORIGIN);
        }
        const repeated = (await second.invoke("jobs.create", input)) as CreatedJob;
        const leadId = repeated.leadConversation;
        assert.ok(leadId, "the repeated call names the lead conversation");
        await untilRequestAnswered(second, leadId, "first input");
        await untilIdle(second, [leadId]);

        const { jobs } = (await second.invoke("jobs.list", {})) as { jobs: CreatedJob[] };
        assert.deepEqual(
            jobs.map((job) => job.id),
            [repeated.id],
            "one job",
        );
        const lead = await conversationsOfJob(second, repeated.id);
        assert.deepEqual(
            lead.map((conversation) => conversation.id),
            [leadId],
            "one lead conversation",
        );
        const entries = await entriesOf(second, leadId);
        assert.equal(entries.filter(takesInput("first input")).length, 1, "the first input was taken once");
        assert.equal(entries.filter(answers("first input")).length, 1, "the first input was answered once");
        const again = (await second.invoke("jobs.create", input)) as CreatedJob;
        assert.deepEqual([again.id, again.leadConversation], [repeated.id, leadId], "a further repeat finds the lead");
    });
});
