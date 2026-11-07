/**
 * Repair rule 4 across a real `kill -9` (S-001 AC-026.4, S-004 REQ-018, S-002 REQ-002 step 7): the aborts of the Done
 * jobs' conversations must not turn scheduling on, so no run of a Done job sends a model request while the repair runs.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, RESUME_MARKER, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
const DONE_JOB_TEXTS = ["done job A", "done job B", "done job C"];
const IN_PROGRESS_JOB_TEXT = "job still in progress";
const LEAD_CRASH_JOB_TEXT = "crash after the resume";

type ModelRequest = { firstUserText: string; phase: string };
type JobView = { id: string; leadConversation: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const modelRequestsOf = async (daemon: DaemonProcess) =>
    (await daemon.invoke("test.modelRequests", {})) as ModelRequest[];

describe("rule 4: the aborts of several Done jobs after a kill -9", () => {
    it("sends no model request for a Done job's run, and every marked conversation is idle at ready", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        await writeFile(
            join(env.piAgentDir, "settings.json"),
            JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
        );
        const first = startDaemon({ hermetic: env, script: "gated", turnEndRule: false });
        daemons.push(first);
        await first.ready;
        const doneJobs: JobView[] = [];
        for (const text of DONE_JOB_TEXTS) doneJobs.push((await first.invoke("jobs.create", { text })) as JobView);
        await first.invoke("jobs.create", { text: IN_PROGRESS_JOB_TEXT });
        await untilTrue(
            async () =>
                (await modelRequestsOf(first)).filter((request) => request.firstUserText !== RESUME_MARKER).length ===
                DONE_JOB_TEXTS.length + 1,
            "every lead's run to be in its model call",
        );
        await assert.rejects(
            first.invoke("test.cancelJobsThenKill", { jobs: doneJobs.map((job) => job.id) }),
            /exited/,
        );
        await first.exited;

        const second = startDaemon({ hermetic: env, script: "gated", turnEndRule: false });
        daemons.push(second);
        await second.ready;

        const requests = await modelRequestsOf(second);
        const requestsOfDoneJobs = requests.filter((request) =>
            DONE_JOB_TEXTS.some((text) => request.firstUserText.includes(text)),
        );
        assert.deepEqual(requestsOfDoneJobs, [], "no run of a Done job sends a request");
        for (const job of doneJobs) {
            const conversation = (await second.invoke("conversations.get", {
                conversationId: job.leadConversation,
            })) as { status: string };
            assert.equal(conversation.status, "closed", job.leadConversation);
            assert.deepEqual(await second.invoke("tasks.live", { conversationId: job.leadConversation }), []);
        }
        const requestsBeforeResume = requests.slice(
            0,
            requests.findIndex((request) => request.firstUserText === RESUME_MARKER),
        );
        assert.ok(
            requests.some((request) => request.firstUserText === RESUME_MARKER),
            "the host resumed",
        );
        assert.deepEqual(requestsBeforeResume, [], "no request starts before the host resumes");
        await untilTrue(
            async () =>
                (await modelRequestsOf(second)).some((request) => request.firstUserText.includes(IN_PROGRESS_JOB_TEXT)),
            "the In progress job's lead to run again",
        );
    });
});

describe("rule 1: a kill -9 after the host resumes and before the first input is delivered", () => {
    it("delivers the first input once at the next start, before any call other than daemon.status is answered", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        await writeFile(
            join(env.piAgentDir, "settings.json"),
            JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
        );
        const first = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, jobCrashAt: "lead-created" });
        daemons.push(first);
        await first.ready;
        await assert.rejects(first.invoke("jobs.create", { text: LEAD_CRASH_JOB_TEXT }), /exited/);
        await first.exited;

        const second = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, killAfterResume: true });
        daemons.push(second);
        await assert.rejects(second.ready, /exited/);
        assert.equal((await second.exited).signal, "SIGKILL");

        const third = startDaemon({ hermetic: env, script: "echo", turnEndRule: false });
        daemons.push(third);
        await third.ready;

        const [job] = ((await third.invoke("jobs.list", {})) as { jobs: JobView[] }).jobs;
        assert.ok(job);
        const [lead] = (await third.invoke("test.waiting", { job: job.id })) as { id: string }[];
        assert.ok(lead);
        const submission = await third.invoke("test.submissionState", {
            conversationId: lead.id,
            requestId: `lead:${job.id}`,
        });
        assert.ok(submission, "the first input was submitted before the first call after ready");
        const history = (await third.invoke("jobs.history.list", { job: job.id, limit: 100 })) as {
            entries: { field: string }[];
        };
        assert.equal(history.entries.filter((entry) => entry.field === "repair").length, 2, "rule 1 applied twice");
        await untilTrue(
            async () =>
                (await modelRequestsOf(third)).some((request) => request.firstUserText.includes(LEAD_CRASH_JOB_TEXT)),
            "the lead to run on its first input",
        );
        const leadRequests = (await modelRequestsOf(third)).filter((request) =>
            request.firstUserText.includes(LEAD_CRASH_JOB_TEXT),
        );
        assert.equal(leadRequests.length, 1, "the first input is held once");
    });
});
