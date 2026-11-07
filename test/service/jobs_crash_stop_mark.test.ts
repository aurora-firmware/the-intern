/**
 * S-004 REQ-008 across a real `kill -9` between a team member's abort committing a lead's stop mark and pi-durable's
 * abort (ADR-001 decision 4): the abort stays undone, the lead's run resumes at the next start, and the turn-end rule
 * blocks the job as stopped when the job's runs have ended.
 */
import { afterEach, describe, it } from "node:test";
import {
    assertBlockedAsStopped,
    conversationsOf,
    createJob,
    disposeCrashTest,
    hermetic,
    jobOf,
    start,
    TEST_TIMEOUT_MS,
    untilKilled,
    untilStatus,
    untilTrue,
} from "../support/jobs_crash_support.ts";

afterEach(disposeCrashTest);

describe("kill -9 between a lead's stop mark and its abort", () => {
    it("blocks the job as stopped when the resumed run of a running lead ends, with no reminder", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "gated", "lead-stop-marked", true);
        await first.ready;
        const job = await createJob(first, "stop the running lead");
        const leadId = job.leadConversation as string;
        await untilStatus(first, leadId, "running");
        await first.invoke("jobs.update", { job: job.id, definitionOfDone: "the report is filed" });
        await first.invoke("conversations.abort", { conversationId: leadId }).catch(() => undefined);
        await untilKilled(first);

        const second = start(env, "gated", undefined, true);
        await second.ready;
        await untilStatus(second, leadId, "running");
        second.releaseRuns();

        await untilTrue(async () => (await jobOf(second, job.id)).status === "blocked", "the job to be blocked");
        await assertBlockedAsStopped(second, job);
    });

    it("blocks the job as stopped once the runs of a lead parked for invoked agents have ended", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "invoke-parked", "lead-stop-marked");
        await first.ready;
        const job = await createJob(first, "stop the parked lead");
        const leadId = job.leadConversation as string;
        await untilTrue(async () => (await conversationsOf(first, job.id)).length === 3, "both invoked conversations");
        await first.invoke("jobs.update", { job: job.id, definitionOfDone: "the report is filed" });
        await first.invoke("conversations.abort", { conversationId: leadId }).catch(() => undefined);
        await untilKilled(first);

        const second = start(env, "invoke-parked", undefined, true);
        await second.ready;

        await untilTrue(async () => (await jobOf(second, job.id)).status === "blocked", "the job to be blocked");
        await assertBlockedAsStopped(second, job);
    });
});
