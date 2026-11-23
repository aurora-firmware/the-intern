import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readConversationMeta } from "../../src/host/seating.ts";
import { cancelJob } from "../../src/jobs/job_actions.ts";
import { assertNoSummaryPlaced, disposeRigs, SETTLE_MS, start, waitFor } from "../support/compaction_rig.ts";

afterEach(disposeRigs);

describe("a compaction running when the job becomes Done", () => {
    it("is aborted when the lead completes the job, which still records the tool's success and ends the run", async () => {
        const rig = await start([
            { name: "update_job", args: { definitionOfDone: "the work is stopped" } },
            { name: "complete_job", args: { justification: "stopped" } },
        ]);
        const job = await rig.createJob();
        await waitFor(async () => (await rig.status(job.id)) === "done", "the job to be Done");
        await waitFor(() => rig.isIdle(job.leadConversation), "the lead's run to end");
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

        assert.equal(rig.summary.requests, 1, "the compaction was running");
        assert.equal(rig.summary.isAborted, true, "the compaction's model request is aborted");
        assert.ok((await rig.lines(job.leadConversation)).includes("tool complete_job returned"));
        assert.equal(rig.turns.count, 2, "no model request follows the complete call");
        await assertNoSummaryPlaced(rig, job.leadConversation);
    });

    it("is aborted when a team member cancels the job", async () => {
        const rig = await start([
            { name: "update_job", args: { definitionOfDone: "the work is stopped" } },
            { name: "block_job", args: { reason: "which build is failing?" } },
        ]);
        const job = await rig.createJob();
        await waitFor(async () => (await rig.status(job.id)) === "blocked", "the job to be Blocked");
        assert.equal(rig.summary.requests, 1, "the compaction is running");
        const turnsBefore = rig.turns.count;

        await cancelJob(rig.deps, job.id, "no longer needed", { kind: "team_member", wayIn: "web interface" });
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

        assert.equal((await readConversationMeta(rig.ctx.host, job.leadConversation))?.closed, true);
        assert.equal(rig.summary.isAborted, true, "the compaction's model request is aborted");
        assert.equal(rig.turns.count, turnsBefore, "no further model turn");
        await assertNoSummaryPlaced(rig, job.leadConversation);
    });
});
