import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { hasSubmissionWithRequestId } from "../../src/host/conversation_control.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { reminderRequestId } from "../../src/jobs/job_model.ts";
import {
    DAEMON,
    deferred,
    disposeAll,
    invokeAndWait,
    setDefinitionOfDone,
    start,
    waitFor,
} from "../support/turn_end_fixture.ts";

const STOPPED_REASON = "stopped by a team member";

afterEach(disposeAll);

type Started = Awaited<ReturnType<typeof start>>;

/** Starts a job whose lead invokes an agent that holds its run, and returns once that agent runs. */
async function startWithRunningInvoked(mode: "parked" | "steerable") {
    const gate = deferred();
    let isRunning = false;
    const started = await start({
        "invoking lead": [setDefinitionOfDone, invokeAndWait("held worker", mode)],
        "held worker": [
            {
                hold: gate.promise,
                onEntered: () => {
                    isRunning = true;
                },
            },
        ],
    });
    const job = await started.createJob("invoking lead");
    await waitFor(() => isRunning, "the invoked agent to run");
    return { started, job };
}

async function runningJobConversations(started: Started, jobId: string, leadId: string) {
    const running: string[] = [];
    for (const { id, busy } of await started.ctx.host.listConversations()) {
        if (busy && id !== leadId && (await readConversationMeta(started.ctx.host, id))?.jobId === jobId) {
            running.push(id);
        }
    }
    return running;
}

async function expectStoppedBlock(started: Started, job: { id: string; leadConversation: string }) {
    await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");
    assert.equal((await started.ctx.jobStore.getJob(job.id)).blockedReason, STOPPED_REASON);
    const [, blocked] = await started.statusChanges(job.id);
    assert.deepEqual([blocked?.new, blocked?.author], ["blocked", DAEMON]);
    assert.deepEqual(await started.steersOf(job.leadConversation), []);
    assert.equal(
        await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, reminderRequestId(job.id, 0)),
        false,
    );
    assert.deepEqual(await runningJobConversations(started, job.id, job.leadConversation), []);
}

describe("the turn-end rule for a lead stopped with an invoked agent running", () => {
    it("blocks the job with the lead parked and no reminder when the lead is parked (AC-008.5 case 5)", async () => {
        const { started, job } = await startWithRunningInvoked("parked");

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        await expectStoppedBlock(started, job);
        assert.ok((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked);
    });

    it("blocks the job once the invoked agent's run has ended when the lead is steerable (AC-008.5 case 6)", async () => {
        const { started, job } = await startWithRunningInvoked("steerable");

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        await expectStoppedBlock(started, job);
        assert.ok((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked);
        await started.barrier();
        // Three checks: the lead's first turn end, the stop listener's, and the invoked agent's run ending while the
        // lead's stop mark is live. Without the last, there are two.
        assert.equal(started.turnEndsOf(job.id), 3);
    });

    it("does nothing more for a job with no stop mark when an invoked agent's run ends (AC-3)", async () => {
        const { started, job } = await startWithRunningInvoked("steerable");
        const [invokedId] = await runningJobConversations(started, job.id, job.leadConversation);
        assert.ok(invokedId);

        await started.invoke("conversations.abort", { conversationId: invokedId });

        await waitFor(async () => (await started.steersOf(job.leadConversation)).length === 1, "the one reminder");
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");
        assert.notEqual((await started.ctx.jobStore.getJob(job.id)).blockedReason, STOPPED_REASON);
        await started.barrier();
        // Three checks, all of a lead's runs: its first turn, its turn after the aborted report and its turn after the
        // reminder. The invoked agent's run ending with no stop mark adds none.
        assert.equal(started.turnEndsOf(job.id), 3);
    });
});
