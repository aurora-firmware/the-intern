import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { hasQueuedInput, hasSubmissionWithRequestId, submitInput } from "../../src/host/conversation_control.ts";
import { parkConversation } from "../../src/host/invocation.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { reminderRequestId } from "../../src/jobs/job_model.ts";
import { checkTurnEnd, REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { leadConversationOf } from "../../src/service/job_operations.ts";
import {
    DAEMON,
    deferred,
    disposeAll,
    invokeAndWait,
    setDefinitionOfDone,
    settle,
    start,
    TEAM_TEXT,
    waitFor,
} from "../support/turn_end_fixture.ts";

afterEach(disposeAll);
describe("the turn-end rule", () => {
    it("blocks a job with no definition of done when its lead stops, with the daemon as author (AC-1)", async () => {
        const started = await start({ "no definition": [] });
        const job = await started.createJob("no definition of done here");

        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.blockedReason, "no definition of done");
        const [, blocked] = await started.statusChanges(job.id);
        assert.deepEqual([blocked?.new, blocked?.author], ["blocked", DAEMON]);
        const reasons = (await started.ctx.jobStore.listHistory(job.id, { limit: 100 })).entries.filter(
            (entry) => entry.field === "blockedReason",
        );
        assert.deepEqual(
            reasons.map((entry) => [entry.new, entry.author]),
            [["no definition of done", DAEMON]],
        );
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
    });

    it("sends one reminder after the first stop and blocks after the second (AC-2)", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        const job = await started.createJob("with definition of done");

        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        const steers = await started.steersOf(job.leadConversation);
        assert.deepEqual(steers, [{ actor: DAEMON, mode: "followUp", content: REMINDER_TEXT }]);
        assert.deepEqual(started.userMessages["with definition"]?.slice(1), [REMINDER_TEXT]);
        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.blockedReason, "the lead stopped without completing or blocking");
        const [, blocked] = await started.statusChanges(job.id);
        assert.deepEqual([blocked?.new, blocked?.author], ["blocked", DAEMON]);
        assert.equal(
            await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, reminderRequestId(job.id, 0)),
            true,
        );
    });

    it("sends no reminder while the lead is parked for a running invoked agent (AC-3)", async () => {
        const gate = deferred();
        const started = await start({
            "parked lead": [setDefinitionOfDone, invokeAndWait("slow worker", "parked")],
            "slow worker": [{ hold: gate.promise }],
        });
        const job = await started.createJob("parked lead");
        await waitFor(() => started.turnEndsOf(job.id) === 1, "the lead's turn to end");
        await started.barrier();

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        gate.release();
    });

    it("sends no reminder while a steerable invoked agent of the job runs (AC-3)", async () => {
        const gate = deferred();
        const started = await start({
            "steerable lead": [setDefinitionOfDone, invokeAndWait("slow helper", "steerable")],
            "slow helper": [{ hold: gate.promise }],
        });
        const job = await started.createJob("steerable lead");
        await waitFor(() => started.turnEndsOf(job.id) === 1, "the lead's turn to end");
        await started.barrier();

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        gate.release();
    });

    it("gives the next stop a new reminder after the job blocked and resumed (AC-4)", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        const job = await started.createJob("with definition of done");
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        await started.invoke("jobs.resume", { job: job.id });
        await waitFor(async () => (await started.steersOf(job.leadConversation)).length === 3, "a new reminder");

        const contents = (await started.steersOf(job.leadConversation)).map((steer) => steer.content);
        assert.equal(contents.filter((content) => content === REMINDER_TEXT).length, 2);
        const { host } = started.ctx;
        for (const n of [0, 2]) {
            assert.equal(
                await hasSubmissionWithRequestId(host, job.leadConversation, reminderRequestId(job.id, n)),
                true,
            );
        }
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block again");
    });

    it("applies no rule when the Jobs component is created with turnEndRule false (AC-5)", async () => {
        const started = await start({ "no definition": [] }, { turnEndRule: false });
        const job = await started.createJob("no definition of done here");
        await waitFor(async () => started.isIdle(job.leadConversation), "the lead to stop");

        await settle();

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
    });

    it("applies no rule to a lead whose job is not in the job store (AC-5)", async () => {
        const lines: string[] = [];
        const started = await start({}, { lines });
        const { ctx } = started;
        const { conversationId } = await createSeatedConversation(ctx.host, {
            scope: "test",
            key: "orphan",
            job: { jobId: "no-such-job", isLead: true, origin: { kind: "request", wayIn: "test" }, depth: 0 },
            seat: started.leadSeat(),
            actor: { kind: "team_member", wayIn: "test" },
        });
        await submitInput(ctx.host, conversationId, { content: "go", requestId: "r1", busyMode: "followUp" });
        await waitFor(() => started.isIdle(conversationId), "the run to end");

        await started.barrier();

        assert.deepEqual(await started.steersOf(conversationId), []);
        assert.equal(
            lines.some((line) => line.includes(" ERROR ")),
            false,
        );
    });
});

describe("the turn-end rule beside other actors", () => {
    it("does nothing for a stop whose job was completed before the check ran", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        started.hooks.onWrite = async (point, jobId) => {
            if (point === "turn-ended") {
                await started.invoke("jobs.complete", { job: jobId, justification: "done by a team member" });
            }
        };
        const job = await started.createJob("with definition of done");
        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");

        await started.barrier();

        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        assert.deepEqual(
            (await started.statusChanges(job.id)).map((entry) => entry.new),
            ["in_progress", "done"],
        );
    });

    it("sends no reminder when a team member's input starts the lead's next run before the check", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        let isInjected = false;
        started.hooks.onWrite = async (point, jobId) => {
            if (point !== "turn-ended" || isInjected) return;
            isInjected = true;
            await started.invoke("conversations.submit", {
                conversationId: await leadConversationOf(started.ctx.host, jobId),
                content: TEAM_TEXT,
                requestId: "team-1",
                busyMode: "followUp",
            });
        };
        const job = await started.createJob("with definition of done");
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        assert.deepEqual(started.userMessages["with definition"]?.slice(1), [TEAM_TEXT, REMINDER_TEXT]);
    });

    it("does nothing for a lead that still has a run", async () => {
        const gate = deferred();
        let isHolding = false;
        const started = await start(
            {
                "busy lead": [
                    setDefinitionOfDone,
                    {
                        hold: gate.promise,
                        onEntered: () => {
                            isHolding = true;
                        },
                    },
                ],
            },
            { turnEndRule: false },
        );
        const job = await started.createJob("busy lead");
        await waitFor(() => isHolding, "the lead to hold its run");

        await checkTurnEnd(started.jobDeps, job.id);

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        gate.release();
    });

    it("does nothing for a lead that reads as not running while input is queued for it", async () => {
        const gate = deferred();
        let isHolding = false;
        const started = await start(
            {
                "queued lead": [
                    setDefinitionOfDone,
                    {
                        hold: gate.promise,
                        onEntered: () => {
                            isHolding = true;
                        },
                    },
                ],
            },
            { turnEndRule: false },
        );
        const job = await started.createJob("queued lead");
        await waitFor(() => isHolding, "the lead to hold its run");
        // The lead really has a run, so pi-durable keeps the input queued; the stub below reports the lead as not
        // running, which leaves the queued input as the only reason for the rule to wait.
        await submitInput(started.ctx.host, job.leadConversation, {
            content: TEAM_TEXT,
            requestId: "team-1",
            busyMode: "followUp",
        });
        assert.equal(await hasQueuedInput(started.ctx.host, job.leadConversation), true);
        const host = started.ctx.host;
        const realInfo = host.conversationInfo;
        host.conversationInfo = async () => ({ busy: false }) as Awaited<ReturnType<typeof realInfo>>;
        try {
            await checkTurnEnd(started.jobDeps, job.id);
        } finally {
            host.conversationInfo = realInfo;
        }

        assert.equal(await started.status(job.id), "in_progress");
        // The held run keeps a reminder out of the transcript, so look for its submission instead.
        const reminderId = reminderRequestId(job.id, 0);
        assert.equal(await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, reminderId), false);
        gate.release();
    });

    it("blocks a job without a reminder when its lead's run was aborted with a reset queued", async () => {
        const gate = deferred();
        let isHolding = false;
        const started = await start({
            "aborted lead": [
                setDefinitionOfDone,
                {
                    hold: gate.promise,
                    onEntered: () => {
                        isHolding = true;
                    },
                },
            ],
        });
        const job = await started.createJob("aborted lead");
        const leadId = job.leadConversation;
        await waitFor(() => isHolding, "the lead to hold its run");
        await started.invoke("conversations.reset", { conversationId: leadId });
        await started.invoke("conversations.abort", { conversationId: leadId });

        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        const reminderId = reminderRequestId(job.id, 0);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).blockedReason, "stopped by a team member");
        assert.equal(await hasSubmissionWithRequestId(started.ctx.host, leadId, reminderId), false);
        assert.deepEqual(await started.steersOf(leadId), []);
    });

    it("blocks a job with no definition of done as stopped when its lead's run was aborted with a reset queued", async () => {
        const gate = deferred();
        let isHolding = false;
        const started = await start({
            "aborted bare lead": [
                {
                    hold: gate.promise,
                    onEntered: () => {
                        isHolding = true;
                    },
                },
            ],
        });
        const job = await started.createJob("aborted bare lead");
        await waitFor(() => isHolding, "the lead to hold its run");
        await started.invoke("conversations.reset", { conversationId: job.leadConversation });
        await started.invoke("conversations.abort", { conversationId: job.leadConversation });

        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");
        assert.equal((await started.ctx.jobStore.getJob(job.id)).blockedReason, "stopped by a team member");
    });

    it("does nothing for an idle lead that is parked", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] }, { turnEndRule: false });
        const job = await started.createJob("with definition of done");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop");
        await parkConversation(started.ctx.host, job.leadConversation, { waitingFor: "reports", continueOn: "each" });

        await checkTurnEnd(started.jobDeps, job.id);

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
    });

    it("sends the reminder and then blocks when the check is called directly for an idle lead", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] }, { turnEndRule: false });
        const job = await started.createJob("with definition of done");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop");

        await checkTurnEnd(started.jobDeps, job.id);
        await waitFor(async () => (await started.steersOf(job.leadConversation)).length === 1, "the reminder");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop again");
        await checkTurnEnd(started.jobDeps, job.id);

        assert.equal(await started.status(job.id), "blocked");
        assert.equal((await started.steersOf(job.leadConversation)).length, 1);
    });

    it("logs a failed check and still handles the next stop", async () => {
        const lines: string[] = [];
        const started = await start({ "with definition": [setDefinitionOfDone] }, { lines });
        let isFirst = true;
        started.hooks.onWrite = (point) => {
            if (point !== "turn-ended" || !isFirst) return;
            isFirst = false;
            throw new Error("the hook failed");
        };
        await started.createJob("with definition of done");
        await waitFor(() => lines.some((line) => line.includes("the hook failed")), "the failure to be logged");

        const next = await started.createJob("no definition of done here");

        await waitFor(async () => (await started.status(next.id)) === "blocked", "the next job to block");
        assert.ok(lines.some((line) => line.includes(" ERROR ")));
    });
});
