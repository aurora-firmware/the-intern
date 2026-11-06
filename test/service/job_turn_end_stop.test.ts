import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { hasSubmissionWithRequestId } from "../../src/host/conversation_control.ts";
import { abortWithAwaited } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { reminderRequestId } from "../../src/jobs/job_model.ts";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import {
    call,
    DAEMON,
    deferred,
    disposeAll,
    type Step,
    setDefinitionOfDone,
    start,
    TEAM_TEXT,
    waitFor,
} from "../support/turn_end_fixture.ts";

const STOPPED_REASON = "stopped by a team member";

afterEach(disposeAll);

type Started = Awaited<ReturnType<typeof start>>;

/** Starts a job whose lead holds a run after the steps, and returns once the run is held. */
async function startHeldLead(key: string, steps: Step[]) {
    const gate = deferred();
    let isHolding = false;
    const started = await start({
        [key]: [
            ...steps,
            {
                hold: gate.promise,
                onEntered: () => {
                    isHolding = true;
                },
            },
        ],
    });
    const job = await started.createJob(key);
    await waitFor(() => isHolding, "the lead to hold its run");
    return { started, job, gate };
}

/** The daemon's reminders in the lead's transcript, apart from the team member's answers. */
async function reminders(started: Started, leadId: string) {
    return (await started.steersOf(leadId)).filter((steer) => steer.content === REMINDER_TEXT);
}

async function expectStoppedBlock(started: Started, job: { id: string; leadConversation: string }) {
    await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");
    const stored = await started.ctx.jobStore.getJob(job.id);
    assert.equal(stored.blockedReason, STOPPED_REASON);
    const [, blocked] = await started.statusChanges(job.id);
    assert.deepEqual([blocked?.new, blocked?.author], ["blocked", DAEMON]);
    assert.deepEqual(await started.steersOf(job.leadConversation), []);
    assert.equal(
        await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, reminderRequestId(job.id, 0)),
        false,
    );
    assert.ok((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked);
}

describe("the turn-end rule for a lead a team member stopped", () => {
    it("blocks a job with a definition of done at once, with no reminder and the lead parked (AC-008.5)", async () => {
        const { started, job } = await startHeldLead("stopped lead", [setDefinitionOfDone]);

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        await expectStoppedBlock(started, job);
    });

    it("blocks the same way when the front desk's stop tool aborts the lead (AC-008.5)", async () => {
        const { started, job } = await startHeldLead("tool stopped", [setDefinitionOfDone]);

        await abortWithAwaited(started.ctx.host, job.leadConversation);

        await expectStoppedBlock(started, job);
    });

    it("gives the one reminder at the lead's next stop after a team member answers (AC-008.5)", async () => {
        const { started, job, gate } = await startHeldLead("answered lead", [setDefinitionOfDone]);
        await started.invoke("conversations.abort", { conversationId: job.leadConversation });
        await expectStoppedBlock(started, job);
        // The aborted reply left no assistant message, so the script holds again unless its gate is open.
        gate.release();

        await started.invoke("conversations.submit", {
            conversationId: job.leadConversation,
            content: TEAM_TEXT,
            requestId: "team-1",
            busyMode: "reject",
        });

        await waitFor(async () => (await reminders(started, job.leadConversation)).length === 1, "the one reminder");
        assert.deepEqual(await reminders(started, job.leadConversation), [
            { actor: DAEMON, mode: "followUp", content: REMINDER_TEXT },
        ]);
        assert.equal(
            await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, reminderRequestId(job.id, 2)),
            true,
        );
    });

    it("blocks for no definition of done at the next stop after an answer when it is empty (AC-008.5)", async () => {
        const { started, job, gate } = await startHeldLead("bare stopped lead", []);
        await started.invoke("conversations.abort", { conversationId: job.leadConversation });
        await expectStoppedBlock(started, job);
        // The aborted reply left no assistant message, so the script holds again unless its gate is open.
        gate.release();

        await started.invoke("conversations.submit", {
            conversationId: job.leadConversation,
            content: TEAM_TEXT,
            requestId: "team-1",
            busyMode: "reject",
        });

        await waitFor(
            async () => (await started.ctx.jobStore.getJob(job.id)).blockedReason === "no definition of done",
            "the job to block for no definition of done",
        );
        assert.deepEqual(await reminders(started, job.leadConversation), []);
    });

    it("adds no history entry for an abort of a lead whose turn just ended, and gives the one reminder (AC-008.7)", async () => {
        const started = await start({ "just ended": [setDefinitionOfDone] });
        const check = deferred();
        let isHeld = false;
        started.hooks.onWrite = async (point) => {
            if (point !== "turn-ended" || isHeld) return;
            isHeld = true;
            await check.promise;
        };
        const job = await started.createJob("just ended");
        await waitFor(() => isHeld, "the check to be held");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop");

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });
        assert.deepEqual(
            (await started.statusChanges(job.id)).map((entry) => entry.new),
            ["in_progress"],
        );
        check.release();

        await waitFor(async () => (await reminders(started, job.leadConversation)).length === 1, "the one reminder");
    });

    it("leaves a Blocked job Blocked with its reason when its lead is aborted (AC-008.7)", async () => {
        const started = await start({ "blocking lead": [call("block_job", { reason: "need an answer" })] });
        const job = await started.createJob("blocking lead");
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop");
        const before = await started.statusChanges(job.id);

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });
        await started.barrier();

        assert.equal(await started.status(job.id), "blocked");
        assert.equal((await started.ctx.jobStore.getJob(job.id)).blockedReason, "need an answer");
        assert.equal((await started.statusChanges(job.id)).length, before.length);
    });
});
