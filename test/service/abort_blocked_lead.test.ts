/**
 * An abort that names the lead of a Blocked job leaves it parked for an answer (S-001 REQ-008, REQ-014, AC-008.7,
 * AC-014.2; S-004 REQ-006, REQ-018 rule 2). An abort of a conversation parked for reports, and the job's abort, clear
 * the park (S-001 AC-026.1).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { deskSteeringTools } from "../../src/desk/desk_steering_tools.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { call, disposeAll, invokeAndWait, setDefinitionOfDone, start, waitFor } from "../support/turn_end_fixture.ts";

const REASON = "which build is failing?";
const ANSWER = "the nightly build on ci-2";

afterEach(disposeAll);

type Started = Awaited<ReturnType<typeof start>>;

/** A job whose lead has blocked it and sits parked for an answer. */
async function startBlocked() {
    const started = await start({ "block me": [call("block_job", { reason: REASON })] }, { turnEndRule: false });
    const job = await started.createJob("block me");
    await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to be Blocked");
    await waitFor(async () => (await listingOf(started, job.leadConversation)).status === "parked", "the lead to park");
    return { started, job };
}

const listingOf = async (started: Started, conversationId: string) =>
    (await started.invoke("conversations.get", { conversationId })) as { status: string };

async function assertStillBlockedAndParked(started: Started, jobId: string, leadId: string) {
    assert.equal((await listingOf(started, leadId)).status, "parked");
    const job = (await started.invoke("jobs.get", { job: jobId })) as { status: string; blockedReason?: string };
    assert.equal(job.status, "blocked");
    assert.equal(job.blockedReason, REASON);
}

describe("an abort that names the lead of a Blocked job", () => {
    it("keeps the lead parked and the job Blocked with its reason after conversations.abort", async () => {
        const { started, job } = await startBlocked();

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        await assertStillBlockedAndParked(started, job.id, job.leadConversation);
    });

    it("keeps the lead parked and the job Blocked with its reason after the front desk's stop_conversation", async () => {
        const { started, job } = await startBlocked();
        const [stopTool] = deskSteeringTools({
            host: () => started.ctx.host,
            jobStore: () => started.ctx.jobStore,
            catalogue: () => assert.fail("stop_conversation reads no catalogue"),
            createJob: () => assert.fail("stop_conversation creates no job"),
        }).slice(1);
        assert.equal(stopTool?.name, "stop_conversation");

        const result = await stopTool.execute({ conversationId: job.leadConversation }, {} as never, {} as never);

        assert.notEqual((result as { isError?: boolean }).isError, true);
        await assertStillBlockedAndParked(started, job.id, job.leadConversation);
    });

    it("still empties awaiting and held", async () => {
        const { started, job } = await startBlocked();

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
        assert.deepEqual([meta?.awaiting, meta?.held], [[], []]);
    });

    it("lets a team member's answer set the job In progress and continue the lead on it", async () => {
        const { started, job } = await startBlocked();
        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        await started.invoke("conversations.submit", {
            conversationId: job.leadConversation,
            content: ANSWER,
            requestId: "answer-1",
            busyMode: "followUp",
        });

        await waitFor(async () => (await started.status(job.id)) === "in_progress", "the job to resume");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to finish its run");
        assert.notEqual((await listingOf(started, job.leadConversation)).status, "parked");
        const users = started.userMessages["block me"] ?? [];
        assert.ok(
            users.some((text) => text.includes(ANSWER)),
            "the lead took the answer as input",
        );
    });
});

describe("an abort that clears the park", () => {
    it("clears a park for reports when the abort names the conversation", async () => {
        const started = await start({
            "invoking lead": [setDefinitionOfDone, invokeAndWait("held worker", "parked")],
            "held worker": [{ hold: new Promise(() => undefined) }],
        });
        const job = await started.createJob("invoking lead");
        await waitFor(
            async () => (await listingOf(started, job.leadConversation)).status === "parked",
            "the lead to park for reports",
        );

        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
        assert.equal(meta?.parked, null);
        assert.deepEqual(meta?.awaiting, []);
    });

    it("clears the lead's park when the job's abort closes it", async () => {
        const { started, job } = await startBlocked();

        await started.invoke("jobs.cancel", { job: job.id, justification: "no longer needed" });

        const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
        assert.equal(meta?.parked, null);
        assert.equal(meta?.closed, true);
    });
});
