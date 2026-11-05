import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { submissionIdFor, submissionState, submitInput } from "../../src/host/conversation_control.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { ConversationClosedError } from "../../src/host/job_section.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { cancelJob, completeJob } from "../../src/jobs/job_actions.ts";
import { leadStartRequestId } from "../../src/service/job_operations.ts";
import { injectCloseFailures } from "../support/close_failure.ts";
import {
    assertNoSummaryPlaced,
    disposeRigs,
    HELD_AGENT_PROMPT,
    HOLD_STEP,
    type Rig,
    SETTLE_MS,
    start,
    waitFor,
} from "../support/compaction_rig.ts";

afterEach(disposeRigs);

const author = { kind: "team_member", wayIn: "web interface" } as const;

/** A Blocked job whose lead has a running compaction, and an idle invoked conversation of the job. */
async function blockedJobWithChild() {
    const rig = await start([
        { name: "update_job", args: { definitionOfDone: "the work is stopped" } },
        { name: "block_job", args: { reason: "which build is failing?" } },
    ]);
    const job = await rig.createJob();
    await waitFor(async () => (await rig.status(job.id)) === "blocked", "the job to be Blocked");
    await waitFor(() => rig.summary.requests === 1, "the compaction to run");
    const [child] = await createInvokedConversations(rig.ctx.host, {
        invokingId: job.leadConversation,
        callId: "call-1",
        agents: [{ seat: rig.seat(), contextMode: "clean", jobPrompt: "work" }],
        actor: author,
    });
    await waitFor(() => rig.isIdle(child as string), "the invoked conversation to be idle");
    return { rig, job, lead: job.leadConversation, child: child as string };
}

const isClosed = async (rig: Rig, id: string): Promise<boolean> =>
    (await readConversationMeta(rig.ctx.host, id))?.closed === true;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const teamActions = [
    ["jobs.cancel", (rig: Rig, jobId: string) => cancelJob(rig.deps, jobId, "stop", author)],
    ["jobs.complete", (rig: Rig, jobId: string) => completeJob(rig.deps, jobId, "stop", author)],
] as const;

for (const [name, act] of teamActions) {
    describe(`a team member's ${name} that fails while closing the job`, () => {
        it("aborts every conversation of the job and fails when a closed mark after the lead's is rejected", async () => {
            const { rig, job, lead, child } = await blockedJobWithChild();
            const log = injectCloseFailures(rig.ctx.host, { failMark: 2 });

            await assert.rejects(act(rig, job.id), { message: "injected mark failure" });
            await settle();

            assert.equal(await rig.status(job.id), "done");
            assert.ok(log.aborts.includes(lead), "the lead is aborted");
            assert.ok(log.aborts.includes(child), "the invoked conversation is aborted");
        });

        it("stops the compaction of a conversation whose closed mark landed", async () => {
            const { rig, job, lead } = await blockedJobWithChild();
            injectCloseFailures(rig.ctx.host, { failMark: 2 });

            await assert.rejects(act(rig, job.id), { message: "injected mark failure" });
            await settle();

            assert.equal(await isClosed(rig, lead), true);
            assert.equal(rig.summary.isAborted, true, "the compaction's model request is aborted");
            await assertNoSummaryPlaced(rig, lead);
        });

        it("still aborts the others when a compaction's stop is rejected", async () => {
            const { rig, job, child } = await blockedJobWithChild();
            const log = injectCloseFailures(rig.ctx.host, { failMark: 2, failCompactionAbort: true });

            await assert.rejects(act(rig, job.id), { message: "injected mark failure" });
            await settle();

            assert.ok(log.aborts.includes(child), "the invoked conversation is aborted");
        });

        it("fails with the first error when the job's conversations can't be listed for the aborts", async () => {
            const { rig, job } = await blockedJobWithChild();
            injectCloseFailures(rig.ctx.host, { failMark: 1, failListingFrom: 2 });

            await assert.rejects(act(rig, job.id), { message: "injected mark failure" });
            await settle();

            assert.equal(await rig.status(job.id), "done");
        });
    });
}

const abortedSettlement = { state: "unanswered", reason: "aborted" };

async function assertInvokedAgentsStopped(rig: Rig, children: string[]): Promise<void> {
    assert.equal(rig.heldAgents.aborted, 2, "each running invoked agent's model request is aborted");
    for (const child of children) assert.equal(await rig.isIdle(child), true, `${child} stopped running`);
}

/** A running lead and two running invoked agents, each with its model request held, and a follow-up queued. */
async function runningJobWithQueuedFollowUp() {
    const rig = await start([
        { name: "update_job", args: { definitionOfDone: "the work is stopped" } },
        { name: HOLD_STEP, args: {} },
    ]);
    const job = await rig.createJob();
    const lead = job.leadConversation;
    await waitFor(() => rig.turns.count === 2 && rig.summary.requests === 1, "the lead's held turn");
    const children = (await createInvokedConversations(rig.ctx.host, {
        invokingId: lead,
        callId: "call-1",
        agents: [
            { seat: rig.seat(), contextMode: "clean", jobPrompt: HELD_AGENT_PROMPT },
            { seat: rig.seat(), contextMode: "clean", jobPrompt: HELD_AGENT_PROMPT },
        ],
        actor: author,
    })) as string[];
    await waitFor(() => rig.heldAgents.requests === 2, "both invoked agents to be running");
    const followUp = await submitInput(rig.ctx.host, lead, {
        content: "one more thing",
        requestId: "late-1",
        busyMode: "followUp",
    });
    const runInput = await submissionIdFor(rig.ctx.host, lead, leadStartRequestId(job.id));
    assert.ok(runInput, "the lead's run input exists");
    return { rig, job, lead, children, followUp: followUp.submissionId, runInput };
}

for (const [name, act] of teamActions) {
    describe(`a team member's ${name} of a running lead that fails while closing the job`, () => {
        it("aborts the lead and the invoked conversations, settles its input aborted and refuses input when the lead's mark is rejected", async () => {
            const { rig, job, lead, children, followUp, runInput } = await runningJobWithQueuedFollowUp();
            injectCloseFailures(rig.ctx.host, { failMark: 1 });

            await assert.rejects(act(rig, job.id), { message: "injected mark failure" });
            await settle();

            assert.equal(await rig.status(job.id), "done");
            assert.match(rig.logs.join(""), /could not finish closing the job.*injected mark failure/);
            assert.equal(rig.hold.isAborted, true, "the lead's model request is aborted");
            await assertInvokedAgentsStopped(rig, children);
            assert.deepEqual(await submissionState(rig.ctx.host, followUp), abortedSettlement);
            assert.deepEqual(await submissionState(rig.ctx.host, runInput), abortedSettlement);
            assert.equal(rig.turns.count, 2, "the model gets no further request from the lead");
            assert.equal(rig.heldAgents.requests, 2, "the model gets no further request from the invoked agents");
            assert.equal(await isClosed(rig, lead), false, "the lead lists with a status other than closed");
            await assert.rejects(
                submitInput(rig.ctx.host, lead, { content: "hi", requestId: "late-2", busyMode: "followUp" }),
                ConversationClosedError,
            );
        });

        it("aborts the others and leaves running the conversation whose abort is rejected, with every mark landed", async () => {
            const { rig, job, lead, children } = await runningJobWithQueuedFollowUp();
            injectCloseFailures(rig.ctx.host, { failAbortOf: lead });

            await assert.rejects(act(rig, job.id), { message: "injected abort failure" });
            await settle();

            assert.equal(await rig.status(job.id), "done");
            assert.match(rig.logs.join(""), /could not finish closing the job.*injected abort failure/);
            await assertInvokedAgentsStopped(rig, children);
            assert.equal(rig.hold.isAborted, false, "the lead whose abort failed keeps running");
            assert.equal(await isClosed(rig, lead), true);
        });

        it("aborts the others and leaves running the conversation whose abort is rejected, after the lead's mark failed", async () => {
            const { rig, job, lead, children } = await runningJobWithQueuedFollowUp();
            injectCloseFailures(rig.ctx.host, { failMark: 1, failAbortOf: lead });

            await assert.rejects(act(rig, job.id), { message: "injected mark failure" });
            await settle();

            assert.equal(await rig.status(job.id), "done");
            assert.match(rig.logs.join(""), /could not finish closing the job.*injected mark failure/);
            assert.match(rig.logs.join(""), /could not abort a conversation.*injected abort failure/);
            await assertInvokedAgentsStopped(rig, children);
            assert.equal(rig.hold.isAborted, false, "the lead whose abort failed keeps running");
            assert.equal(await isClosed(rig, lead), false);
        });
    });
}

describe("the lead's own complete that fails while closing the job", () => {
    it("stops the compaction of a conversation whose closed mark landed, and places no summary", async () => {
        const { rig, job, lead } = await blockedJobWithChild();
        injectCloseFailures(rig.ctx.host, { failMark: 2 });

        await completeJob(rig.deps, job.id, "stop", author, lead);
        await settle();

        assert.equal(await isClosed(rig, lead), true);
        assert.equal(rig.summary.isAborted, true, "the compaction's model request is aborted");
        await assertNoSummaryPlaced(rig, lead);
    });

    it("aborts the other conversations and the lead when the lead's closed mark is rejected", async () => {
        const { rig, job, lead, child } = await blockedJobWithChild();
        const log = injectCloseFailures(rig.ctx.host, { failMark: 1 });

        await completeJob(rig.deps, job.id, "stop", author, lead);
        await settle();

        assert.ok(log.aborts.includes(child), "the invoked conversation is aborted");
        assert.ok(log.aborts.includes(lead), "the unclosed lead is aborted");
    });
});
