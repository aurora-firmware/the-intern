import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { cancelJob, completeJob } from "../../src/jobs/job_actions.ts";
import { type CloseFailures, injectCloseFailures } from "../support/close_failure.ts";
import { assertNoSummaryPlaced, disposeRigs, type Rig, SETTLE_MS, start, waitFor } from "../support/compaction_rig.ts";

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

const failures: [string, CloseFailures, string][] = [
    ["the lead's closed mark is rejected", { failMark: 1 }, "injected mark failure"],
    ["a closed mark after the lead's is rejected", { failMark: 2 }, "injected mark failure"],
    ["the first abort is rejected after every mark landed", { failAbort: 1 }, "injected abort failure"],
];

for (const [name, act] of teamActions) {
    describe(`a team member's ${name} that fails while closing the job`, () => {
        for (const [what, injected, message] of failures) {
            it(`aborts every conversation of the job and fails when ${what}`, async () => {
                const { rig, job, lead, child } = await blockedJobWithChild();
                const log = injectCloseFailures(rig.ctx.host, injected);

                await assert.rejects(act(rig, job.id), { message });
                await settle();

                assert.equal(await rig.status(job.id), "done");
                assert.ok(log.aborts.includes(lead), "the lead is aborted");
                assert.ok(log.aborts.includes(child), "the invoked conversation is aborted");
            });
        }

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
