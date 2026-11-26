/**
 * Jobs whose lead waits for a model (S-004 REQ-023, REQ-008, REQ-018; ADR-014 decision 2): a `no_model` run end is no
 * turn end, and a set `waitingForModel` fact is something the lead waits for. The job stays as it is, with no
 * reminder, no block and no second submission of the first input. The tests run a daemon on the fake model whose
 * isolated pi agent folder names no default model.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { submissionIdFor, waitForSubmission } from "../../src/host/conversation_control.ts";
import { toConversationId } from "../../src/host/conversation_id.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { NOTICE_KIND } from "../../src/host/model_wait.ts";
import { conversationMetaDoc } from "../../src/host/seating.ts";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { leadStartRequestId } from "../../src/service/job_operations.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { waitForJobStatus } from "../support/job_status.ts";
import {
    entriesOf,
    historyOf,
    jobOf,
    listingOf,
    steersWith,
    TEST_TIMEOUT_MS,
    untilTrue,
} from "../support/jobs_crash_support.ts";
import { scaled } from "../support/time_scale.ts";

const FAKE_MODEL = "faux/faux-1";
const WAIT_MS = scaled(30_000);
const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

// The folder names no default model, so every seat that names no model of its own has none.
async function hermeticWithNoDefault(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.piAgentDir, "settings.json"), "{}");
    return env;
}

function boot(env: HermeticEnv, script: FakeScript = "echo"): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: true });
    daemons.push(daemon);
    return daemon;
}

async function stop(daemon: DaemonProcess): Promise<void> {
    daemon.signal("SIGTERM");
    await daemon.exited;
}

const kindsOf = async (daemon: DaemonProcess, conversationId: string): Promise<string[]> =>
    (await entriesOf(daemon, conversationId)).map((entry) => entry.kind);

const untilNotice = (daemon: DaemonProcess, conversationId: string) =>
    untilTrue(async () => (await kindsOf(daemon, conversationId)).includes(NOTICE_KIND), "the notice");

async function createJob(daemon: DaemonProcess, text: string, role?: string) {
    return (await daemon.invoke("jobs.create", { text, ...(role !== undefined && { role }) })) as {
        id: string;
        leadConversation: string;
    };
}

// The turn-end rule's queue is serial: once a job whose lead has a model and no definition of done is Blocked by it,
// every run end that was queued before has been judged.
async function drainTurnEnds(daemon: DaemonProcess): Promise<void> {
    const job = await createJob(daemon, "drain", "worker");
    await waitForJobStatus(async () => (await jobOf(daemon, job.id)).status, "blocked");
}

async function createRoles(daemon: DaemonProcess): Promise<void> {
    await daemon.invoke("roles.create", { name: "worker", instructions: "Work.", model: FAKE_MODEL });
    await daemon.invoke("roles.create", { name: "idle", instructions: "Wait." });
}

describe("a new job whose lead has no model", () => {
    it("stays To do with no Blocked reason, no resolution and no action in its history", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = boot(await hermeticWithNoDefault());
        await daemon.ready;
        await createRoles(daemon);

        const job = await createJob(daemon, "wait for a model");
        await untilNotice(daemon, job.leadConversation);
        await drainTurnEnds(daemon);

        const stored = await jobOf(daemon, job.id);
        assert.equal(stored.status, "to_do");
        assert.equal(stored.blockedReason, undefined);
        assert.equal((stored as { resolution?: unknown }).resolution, undefined);
        assert.deepEqual(await historyOf(daemon, job.id), []);
        assert.equal(await steersWith(daemon, job.leadConversation, REMINDER_TEXT), 0);
    });
});

describe("a daemon that restarts with a job whose lead's first input waits for a model", () => {
    it("submits the first input once and writes no repair entry", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermeticWithNoDefault();
        const first = boot(env);
        await first.ready;
        const job = await createJob(first, "wait for a model");
        await untilNotice(first, job.leadConversation);
        await stop(first);

        const second = boot(env);
        await second.ready;

        const inputs = (await kindsOf(second, job.leadConversation)).filter((kind) => kind === "pi.user");
        assert.equal(inputs.length, 1);
        assert.equal((await jobOf(second, job.id)).status, "to_do");
        assert.deepEqual(await historyOf(second, job.id), []);
    });
});

// An In progress job whose lead has a model, a definition of done and a run in flight; the folder names no default
// model, so a team member reseats the lead to a role with none and queues more input behind the run. When the run ends
// the queued input starts a run that ends `no_model`: the input waits and the lead waits for a model.
async function inProgressJobWithWaitingLead(daemon: DaemonProcess) {
    await createRoles(daemon);
    const job = await createJob(daemon, "work that waits", "worker");
    await waitForJobStatus(async () => (await jobOf(daemon, job.id)).status, "in_progress");
    await daemon.invoke("jobs.update", { job: job.id, definitionOfDone: "the report is filed" });
    await daemon.invoke("conversations.seat", { conversationId: job.leadConversation, role: "idle" });
    await daemon.invoke("conversations.submit", {
        conversationId: job.leadConversation,
        content: "more work",
        requestId: "more-work",
    });
    daemon.releaseRuns();
    await untilNotice(daemon, job.leadConversation);
    await drainTurnEnds(daemon);
    return job;
}

describe("an In progress job whose lead is reseated to a role with no model and holds input waiting for one", () => {
    it("sends no reminder and blocks nothing after the run ends", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = boot(await hermeticWithNoDefault(), "gated");
        await daemon.ready;

        const job = await inProgressJobWithWaitingLead(daemon);

        assert.equal((await jobOf(daemon, job.id)).status, "in_progress");
        assert.equal(await steersWith(daemon, job.leadConversation, REMINDER_TEXT), 0);
        const statuses = (await historyOf(daemon, job.id)).filter((entry) => entry.field === "status");
        assert.deepEqual(
            statuses.map((entry) => entry.new),
            ["in_progress"],
        );
    });

    it("sends no reminder and blocks nothing after a restart with the folder unchanged", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermeticWithNoDefault();
        const first = boot(env, "gated");
        await first.ready;
        const job = await inProgressJobWithWaitingLead(first);
        await stop(first);

        const second = boot(env, "gated");
        await second.ready;

        assert.equal((await jobOf(second, job.id)).status, "in_progress");
        assert.equal(await steersWith(second, job.leadConversation, REMINDER_TEXT), 0);
        assert.equal((await listingOf(second, job.leadConversation)).status, "idle");
    });
});

// The daemon is stopped, so the test opens the instance's database itself.
async function withStoppedInstance<T>(env: HermeticEnv, use: (host: HarnessHost) => Promise<T>): Promise<T> {
    const host = await openHarnessHost({
        databaseFile: join(env.stateDir, "the-intern.sqlite"),
        models: createModels(),
        harnessSettings: {},
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    try {
        return await use(host);
    } finally {
        await host.close();
    }
}

async function firstInputSettlement(env: HermeticEnv, jobId: string, leadId: string) {
    return withStoppedInstance(env, async (host) => {
        const submissionId = await submissionIdFor(host, leadId, leadStartRequestId(jobId));
        assert.ok(submissionId, "the lead holds its first input's submission");
        return await waitForSubmission(host, submissionId, WAIT_MS);
    });
}

// Leaves the conversation as a `no_model` run end does: its seat has no model and it waits for one.
async function markLeadWaiting(env: HermeticEnv, leadId: string): Promise<void> {
    await withStoppedInstance(env, (host) =>
        internalHarness(host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, toConversationId(leadId));
            meta.seat.model = null;
            meta.waitingForModel = { order: "1" };
        }, BACKGROUND_CONTEXT),
    );
}

const repairRulesOf = async (daemon: DaemonProcess, jobId: string): Promise<number[]> =>
    (await historyOf(daemon, jobId))
        .filter((entry) => entry.field === "repair")
        .map((entry) => (entry.new as { rule: number }).rule);

describe("a job whose lead waits for a model and is cancelled", () => {
    it("closes the lead and leaves its first input's submission settled no_model", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermeticWithNoDefault();
        const daemon = boot(env);
        await daemon.ready;
        const job = await createJob(daemon, "wait for a model");
        await untilNotice(daemon, job.leadConversation);

        await daemon.invoke("jobs.cancel", { job: job.id, justification: "not needed" });

        assert.equal((await listingOf(daemon, job.leadConversation)).status, "closed");
        assert.equal((await jobOf(daemon, job.id)).status, "done");
        await stop(daemon);
        assert.deepEqual(await firstInputSettlement(env, job.id, job.leadConversation), {
            state: "unanswered",
            reason: "no_model",
        });
    });
});

describe("the repair at startup of a job whose lead holds input waiting for a model", () => {
    it("rule 3 sets a Blocked job In progress and leaves its lead unreminded", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermeticWithNoDefault();
        const first = boot(env);
        await first.ready;
        await createRoles(first);
        const job = await createJob(first, "block for want of a definition", "worker");
        await waitForJobStatus(async () => (await jobOf(first, job.id)).status, "blocked");
        await stop(first);
        await markLeadWaiting(env, job.leadConversation);

        const second = boot(env);
        await second.ready;

        const stored = await jobOf(second, job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        assert.deepEqual(await repairRulesOf(second, job.id), [3]);
        assert.equal(await steersWith(second, job.leadConversation, REMINDER_TEXT), 0);
    });

    it("rule 4 closes the conversations of a Done job", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermeticWithNoDefault();
        const first = boot(env);
        await first.ready;
        await createRoles(first);
        const job = await createJob(first, "finish before the model comes", "worker");
        await waitForJobStatus(async () => (await jobOf(first, job.id)).status, "blocked");
        await first.invoke("jobs.cancel", { job: job.id, justification: "not needed" });
        await stop(first);
        await markLeadWaiting(env, job.leadConversation);

        const second = boot(env);
        await second.ready;

        assert.deepEqual(await repairRulesOf(second, job.id), [4]);
        assert.equal((await listingOf(second, job.leadConversation)).status, "closed");
    });
});
