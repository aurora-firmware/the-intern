/**
 * An abort and a close end the wait for a model (ADR-014 decision 7, ADR-001 decision 4; S-001 REQ-008, REQ-026,
 * REQ-027; S-004 REQ-023). The input stays in the transcript, its submission keeps reason `no_model`, and no run
 * answers it when the folder comes to name a default model. The tests run a daemon on the fake model with one worker
 * thread and rewrite `settings.json` in its isolated pi agent folder.
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
    STOPPED_REASON,
    steersWith,
    TEST_TIMEOUT_MS,
    untilTrue,
} from "../support/jobs_crash_support.ts";
import { scaled } from "../support/time_scale.ts";

const FAKE_MODEL = "faux/faux-1";
const WAIT_MS = scaled(30_000);
const ABORTED_TEXT = "aborted input";
const CANCELLED_TEXT = "cancelled job";
const PROBE_TEXT = "probe job";

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermeticWithNoDefault(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.piAgentDir, "settings.json"), "{}");
    return env;
}

function boot(env: HermeticEnv, script: FakeScript = "echo"): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: true, workerThreads: 1 });
    daemons.push(daemon);
    return daemon;
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

const requestsFor = async (daemon: DaemonProcess, text: string): Promise<number> =>
    ((await daemon.invoke("test.modelRequests", {})) as { firstUserText: string }[]).filter((request) =>
        request.firstUserText.includes(text),
    ).length;

// The folder comes to name a default model; a probe job's lead, which waits too, is answered once the daemon has
// noticed, so a run that would answer another waiting input has started by then.
async function nameDefaultModelAndAwaitProbe(env: HermeticEnv, daemon: DaemonProcess): Promise<void> {
    const probe = await createJob(daemon, PROBE_TEXT);
    await untilNotice(daemon, probe.leadConversation);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }),
    );
    await untilTrue(async () => (await requestsFor(daemon, PROBE_TEXT)) > 0, "the probe lead to be answered");
}

async function stop(daemon: DaemonProcess): Promise<void> {
    daemon.signal("SIGTERM");
    await daemon.exited;
}

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

const factOf = (env: HermeticEnv, conversationId: string) =>
    withStoppedInstance(env, async (host) => {
        const id = toConversationId(conversationId);
        return await internalHarness(host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, id);
            return meta.waitingForModel;
        }, BACKGROUND_CONTEXT);
    });

describe("a conversation waiting for a model that a team member aborts", () => {
    it("is not answered when the folder later names a default model, and its submission keeps no_model", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermeticWithNoDefault();
        const daemon = boot(env);
        await daemon.ready;
        const { conversationId: desk } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
        const { submissionId } = (await daemon.invoke("conversations.submit", {
            conversationId: desk,
            content: ABORTED_TEXT,
            requestId: "aborted-1",
        })) as { submissionId: string };
        await untilNotice(daemon, desk);

        await daemon.invoke("conversations.abort", { conversationId: desk });
        await nameDefaultModelAndAwaitProbe(env, daemon);

        assert.equal(await requestsFor(daemon, ABORTED_TEXT), 0);
        assert.deepEqual(await daemon.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS }), {
            state: "unanswered",
            reason: "no_model",
        });
        assert.ok((await kindsOf(daemon, desk)).includes("pi.user"), "the input stays in the transcript");
    });
});

// An In progress job whose lead has a model, a definition of done and a run in flight; the folder names no default
// model, so a team member reseats the lead to a role with none and queues more input behind the run. When the run ends
// the queued input starts a run that ends `no_model`: the input waits and the lead waits for a model.
async function inProgressJobWithWaitingLead(daemon: DaemonProcess) {
    await daemon.invoke("roles.create", { name: "worker", instructions: "Work.", model: FAKE_MODEL });
    await daemon.invoke("roles.create", { name: "idle", instructions: "Wait." });
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
    return job;
}

describe("a team member's abort of the lead of an In progress job that waits for a model", () => {
    it("blocks the job as stopped by a team member and sends no reminder", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = boot(await hermeticWithNoDefault(), "gated");
        await daemon.ready;
        const job = await inProgressJobWithWaitingLead(daemon);

        await daemon.invoke("conversations.abort", { conversationId: job.leadConversation });

        await waitForJobStatus(async () => (await jobOf(daemon, job.id)).status, "blocked");
        const stored = await jobOf(daemon, job.id);
        assert.equal(stored.blockedReason, STOPPED_REASON);
        assert.equal(await steersWith(daemon, job.leadConversation, REMINDER_TEXT), 0);
        const statuses = (await historyOf(daemon, job.id)).filter((entry) => entry.field === "status");
        assert.deepEqual(
            statuses.map((entry) => entry.new),
            ["in_progress", "blocked"],
        );
    });
});

describe("a job whose lead waits for a model and is cancelled", () => {
    it("clears the fact as it closes the lead, and no run starts when the default model appears", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermeticWithNoDefault();
        const daemon = boot(env);
        await daemon.ready;
        const job = await createJob(daemon, CANCELLED_TEXT);
        await untilNotice(daemon, job.leadConversation);

        await daemon.invoke("jobs.cancel", { job: job.id, justification: "not needed" });
        assert.equal((await listingOf(daemon, job.leadConversation)).status, "closed");
        await nameDefaultModelAndAwaitProbe(env, daemon);

        assert.equal(await requestsFor(daemon, CANCELLED_TEXT), 0);
        await stop(daemon);
        assert.equal(await factOf(env, job.leadConversation), undefined);
        const submissionId = await withStoppedInstance(env, (host) =>
            submissionIdFor(host, job.leadConversation, leadStartRequestId(job.id)),
        );
        assert.ok(submissionId, "the lead holds its first input's submission");
        assert.deepEqual(await withStoppedInstance(env, (host) => waitForSubmission(host, submissionId, WAIT_MS)), {
            state: "unanswered",
            reason: "no_model",
        });
    });
});
