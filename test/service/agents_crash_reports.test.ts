import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 20;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const ENTRIES_LIMIT = 200;
const SLOW_DELAY_MS = 4_000;
const LONG_DELAY_MS = 15_000;
const QUEUE_DELAY_MS = 6_000;
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
const WAITING_STATUS = "waiting for a worker thread";
const REQUEST_ORIGIN = { kind: "request", wayIn: "cli" };
const JOB_PROMPTS = ["job A", "job B"];
const JOB_ID = "report-job";

type Entry = { kind: string; data: unknown };
type Listing = { id: string; status: string };
type Status = {
    workerThreads: { inUse: number; waiting: { conversationId: string; position: number }[] };
};

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

function start(
    env: HermeticEnv,
    script: FakeScript,
    options: { workerThreads?: number; delayMs?: number } = {},
): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script, delayMs: SLOW_DELAY_MS, ...options });
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

async function startLead(daemon: DaemonProcess, jobId: string, firstInput: string): Promise<string> {
    const { conversationId } = (await daemon.invoke("jobs.startLead", {
        jobId,
        firstInput,
        origin: REQUEST_ORIGIN,
    })) as { conversationId: string };
    return conversationId;
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

const statusOf = async (daemon: DaemonProcess): Promise<Status> => (await daemon.invoke("daemon.status", {})) as Status;

const takesInput = (text: string) => (entry: Entry) =>
    entry.kind === "pi.user" && JSON.stringify(entry.data).includes(text);
const mentions = (text: string) => (entry: Entry) =>
    entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes(text);

/** Starts a lead that parks on two invoked agents whose slow answers are not yet reported. Returns the lead's id. */
async function startParkedLead(daemon: DaemonProcess): Promise<string> {
    const leadId = await startLead(daemon, JOB_ID, "lead work");
    await untilTrue(async () => (await listingOf(daemon, leadId)).status === "parked", "the lead to park");
    return leadId;
}

async function invokedOf(daemon: DaemonProcess, leadId: string): Promise<string[]> {
    const conversations = await conversationsOfJob(daemon, JOB_ID);
    return conversations.map((conversation) => conversation.id).filter((id) => id !== leadId);
}

async function untilIdle(daemon: DaemonProcess, conversationIds: string[]): Promise<void> {
    await untilTrue(async () => {
        for (const id of conversationIds) if ((await listingOf(daemon, id)).status !== "idle") return false;
        return true;
    }, "every conversation to be idle");
}

async function assertEachReportReachedLeadOnce(daemon: DaemonProcess, leadId: string): Promise<void> {
    await untilTrue(async () => {
        const entries = await entriesOf(daemon, leadId);
        return JOB_PROMPTS.every((prompt) => entries.some(mentions(`echo: echo: ${prompt}`)));
    }, "the lead to answer both reports");
    await untilIdle(daemon, [leadId]);
    const entries = await entriesOf(daemon, leadId);
    for (const prompt of JOB_PROMPTS) {
        assert.equal(entries.filter(takesInput(`echo: ${prompt}`)).length, 1, `the report of ${prompt} came once`);
        assert.equal(entries.filter(mentions(`echo: echo: ${prompt}`)).length, 1, `the report of ${prompt} ran once`);
    }
}

describe("kill -9 while a conversation is parked", () => {
    it("keeps it parked without a worker thread and continues it when its reports arrive", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "invoke-parked");
        await first.ready;
        const leadId = await startParkedLead(first);
        await crash(first);

        const second = start(env, "invoke-parked", { delayMs: LONG_DELAY_MS });
        await second.ready;

        assert.equal((await listingOf(second, leadId)).status, "parked");
        const { workerThreads } = await statusOf(second);
        assert.ok(
            !workerThreads.waiting.some((waiter) => waiter.conversationId === leadId),
            "the parked lead does not wait for a worker thread",
        );
        assert.ok(workerThreads.inUse <= 2, "only the invoked agents hold worker threads");
        await assertEachReportReachedLeadOnce(second, leadId);
    });
});

describe("kill -9 while a report is being delivered", () => {
    it("delivers each report to the lead exactly once", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "invoke-parked");
        await first.ready;
        const leadId = await startParkedLead(first);
        const invokedIds = await invokedOf(first, leadId);
        await untilTrue(async () => {
            for (const id of invokedIds) {
                const answered = (await entriesOf(first, id)).some((entry) => entry.kind === "pi.assistant");
                if (answered) return true;
            }
            return false;
        }, "the first invoked agent to answer");
        await crash(first);

        const second = start(env, "invoke-parked");
        await second.ready;

        await assertEachReportReachedLeadOnce(second, leadId);
        assert.deepEqual((await invokedOf(second, leadId)).toSorted(), invokedIds.toSorted());
    });
});

describe("kill -9 while work waits for a worker thread", () => {
    it("keeps the waiting work waiting in the same order and runs all of it once", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "slow", { workerThreads: 1, delayMs: QUEUE_DELAY_MS });
        await first.ready;
        const leadIds: string[] = [];
        for (const name of ["one", "two", "three"])
            leadIds.push(await startLead(first, `wait-${name}`, `work ${name}`));
        await untilTrue(async () => (await statusOf(first)).workerThreads.waiting.length === 2, "two leads to wait");
        const before = (await statusOf(first)).workerThreads.waiting;
        await crash(first);

        const second = start(env, "slow", { workerThreads: 1, delayMs: QUEUE_DELAY_MS });
        await second.ready;

        const after = (await statusOf(second)).workerThreads;
        assert.deepEqual(after.waiting, before, "the same conversations wait in the same positions");
        assert.equal(after.inUse, 1);
        const statuses = await Promise.all(before.map(({ conversationId }) => listingOf(second, conversationId)));
        assert.deepEqual(
            statuses.map((listing) => listing.status),
            [WAITING_STATUS, WAITING_STATUS],
        );
        await untilIdle(second, leadIds);
        for (const [index, name] of ["one", "two", "three"].entries()) {
            const entries = await entriesOf(second, leadIds[index] as string);
            assert.equal(entries.filter(mentions(`echo: work ${name}`)).length, 1, `work ${name} ran once`);
        }
    });
});

describe("kill -9 while a message to a parked conversation is held", () => {
    it("delivers the held message once when the conversation continues", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "invoke-parked");
        await first.ready;
        const leadId = await startParkedLead(first);
        const submitted = await first.invoke("conversations.submit", {
            conversationId: leadId,
            content: "held note",
            requestId: "held-1",
            busyMode: "followUp",
        });
        assert.deepEqual(submitted, { held: true });
        await crash(first);

        const second = start(env, "invoke-parked", { delayMs: LONG_DELAY_MS });
        await second.ready;

        assert.equal((await listingOf(second, leadId)).status, "parked");
        assert.equal((await entriesOf(second, leadId)).filter(takesInput("held note")).length, 0, "still held");
        await untilTrue(
            async () => (await entriesOf(second, leadId)).some(mentions("echo: held note")),
            "the held message to be answered",
        );
        await untilIdle(second, [leadId]);
        const entries = await entriesOf(second, leadId);
        assert.equal(entries.filter(takesInput("held note")).length, 1, "the held message came once");
        assert.equal(entries.filter(mentions("echo: held note")).length, 1, "the held message ran once");
    });
});
