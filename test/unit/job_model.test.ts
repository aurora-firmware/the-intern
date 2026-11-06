import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    blockResumeCount,
    checkAction,
    checkEdit,
    EDITABLE_FIELDS,
    formatNumber,
    JOB_TOOL_NAMES,
    type JobAction,
    type JobOrigin,
    type JobStatus,
    letterFor,
    parseJobRef,
    reminderRequestId,
    resumeRequestId,
    turnEndDecision,
} from "../../src/jobs/job_model.ts";

const request = (wayIn: string): JobOrigin => ({ kind: "request", wayIn });
const fullInput = {
    blockedReason: "waiting for the invoice",
    justification: "all done",
    definitionOfDone: "the report exists",
};

describe("letterFor", () => {
    it("maps each origin to its letter", () => {
        assert.equal(letterFor(request("command line")), "C");
        assert.equal(letterFor(request("web interface")), "W");
        assert.equal(letterFor(request("email")), "E");
        assert.equal(letterFor({ kind: "schedule", entry: "daily", fireTime: "2026-11-02T08:00:00Z" }), "S");
        assert.equal(letterFor({ kind: "trigger", trigger: "t", event: "e" }), "T");
        assert.equal(letterFor({ kind: "follow_up", jobId: "j", conversationId: "c" }), "A");
    });

    it("gives no letter for in-process or any other way in", () => {
        assert.equal(letterFor(request("in-process")), undefined);
        assert.equal(letterFor(request("carrier pigeon")), undefined);
        assert.equal(letterFor(request("toString")), undefined);
    });
});

describe("short numbers", () => {
    it("formats a letter and a number", () => {
        assert.equal(formatNumber("E", 14), "E-14");
    });

    it("reads a short number in any letter case", () => {
        assert.deepEqual(parseJobRef("E-14"), { letter: "E", n: 14 });
        assert.deepEqual(parseJobRef("e-14"), { letter: "E", n: 14 });
    });

    it("reads any other text as a job ID", () => {
        for (const text of ["4f0c9a7e-1b2d", "X-14", "E-", "E-1x", "E-0", "job"]) {
            assert.deepEqual(parseJobRef(text), { id: text });
        }
    });
});

const TRANSITIONS: Record<JobAction, Partial<Record<JobStatus, JobStatus>>> = {
    start: { to_do: "in_progress" },
    block: { in_progress: "blocked" },
    resume: { blocked: "in_progress" },
    complete: { in_progress: "done" },
    cancel: { to_do: "done", in_progress: "done", blocked: "done" },
};
const STATUSES: JobStatus[] = ["to_do", "in_progress", "blocked", "done"];
const ACTIONS = Object.keys(TRANSITIONS) as JobAction[];

describe("checkAction", () => {
    for (const action of ACTIONS) {
        for (const status of STATUSES) {
            const to = TRANSITIONS[action][status];
            it(`${to ? "allows" : "refuses"} ${action} from ${status}`, () => {
                const result = checkAction(status, action, fullInput);
                if (to) {
                    assert.deepEqual(result, { ok: true, to });
                } else {
                    assert.equal(result.ok, false);
                    assert.equal(!result.ok && result.code, "conflict");
                }
            });
        }
    }

    it("refuses an empty Blocked reason naming the field", () => {
        for (const blockedReason of [undefined, "", "   "]) {
            const result = checkAction("in_progress", "block", { blockedReason });
            assert.equal(!result.ok && result.code, "invalid_input");
            assert.equal(!result.ok && result.field, "blockedReason");
        }
    });

    it("refuses a block while an invocation runs or is awaited", () => {
        const result = checkAction("in_progress", "block", { blockedReason: "x", activeInvocation: "conv-2" });
        assert.equal(!result.ok && result.code, "invalid_input");
        assert.equal(!result.ok && result.field, "activeInvocation");
    });

    it("refuses a complete without definition of done or justification", () => {
        const noDone = checkAction("in_progress", "complete", { justification: "j", definitionOfDone: " " });
        assert.equal(!noDone.ok && noDone.code, "invalid_input");
        assert.equal(!noDone.ok && noDone.field, "definitionOfDone");
        const noJustification = checkAction("in_progress", "complete", { definitionOfDone: "d" });
        assert.equal(!noJustification.ok && noJustification.code, "invalid_input");
        assert.equal(!noJustification.ok && noJustification.field, "justification");
    });

    it("refuses a cancel without justification", () => {
        for (const status of ["to_do", "in_progress", "blocked"] as const) {
            const result = checkAction(status, "cancel", { justification: "" });
            assert.equal(!result.ok && result.code, "invalid_input");
            assert.equal(!result.ok && result.field, "justification");
        }
    });

    it("reports a wrong status before a failed guard", () => {
        const result = checkAction("to_do", "block", {});
        assert.equal(!result.ok && result.code, "conflict");
    });
});

describe("checkEdit", () => {
    it("lists the editable fields", () => {
        assert.deepEqual([...EDITABLE_FIELDS], ["title", "description", "definitionOfDone"]);
    });

    it("allows editable fields on a job that is not Done", () => {
        for (const status of ["to_do", "in_progress", "blocked"] as const) {
            assert.equal(checkEdit(status, ["title", "description", "definitionOfDone"]).ok, true);
        }
    });

    it("refuses every edit on a Done job with conflict", () => {
        const result = checkEdit("done", ["title"]);
        assert.equal(!result.ok && result.code, "conflict");
    });

    it("refuses the first other field naming it", () => {
        const result = checkEdit("in_progress", ["title", "status", "number"]);
        assert.equal(!result.ok && result.code, "invalid_input");
        assert.equal(!result.ok && result.field, "status");
    });
});

describe("turn-end rule", () => {
    it("blocks for an empty definition of done", () => {
        for (const isReminderSpent of [false, true]) {
            assert.deepEqual(turnEndDecision({ definitionOfDone: "  ", isReminderSpent, isStopped: false }), {
                kind: "block",
                reason: "no definition of done",
            });
        }
    });

    it("reminds once, then blocks", () => {
        assert.deepEqual(turnEndDecision({ definitionOfDone: "d", isReminderSpent: false, isStopped: false }), { kind: "remind" });
        assert.deepEqual(turnEndDecision({ definitionOfDone: "d", isReminderSpent: true, isStopped: false }), {
            kind: "block",
            reason: "the lead stopped without completing or blocking",
        });
    });

    it("blocks as stopped by a team member whatever the definition of done and the reminder hold", () => {
        for (const definitionOfDone of ["d", "  "]) {
            for (const isReminderSpent of [false, true]) {
                assert.deepEqual(turnEndDecision({ definitionOfDone, isReminderSpent, isStopped: true }), {
                    kind: "block",
                    reason: "stopped by a team member",
                });
            }
        }
    });

    it("derives request ids", () => {
        assert.equal(reminderRequestId("job-1", 2), "reminder:job-1:2");
        assert.equal(resumeRequestId("job-1", 3), "resume:job-1:3");
    });

    it("counts one per block and one per resume", () => {
        const status = (old: string, to: string) => ({ field: "status", old, new: to });
        assert.equal(blockResumeCount([]), 0);
        assert.equal(
            blockResumeCount([
                status("to_do", "in_progress"),
                status("in_progress", "blocked"),
                { field: "title", old: "blocked", new: "x" },
                status("blocked", "in_progress"),
                status("in_progress", "blocked"),
                status("blocked", "done"),
            ]),
            4,
        );
    });
});

describe("JOB_TOOL_NAMES", () => {
    it("names the seven tools", () => {
        assert.deepEqual(
            [...JOB_TOOL_NAMES],
            ["read_job", "update_job", "add_worklog", "create_job", "relate_jobs", "block_job", "complete_job"],
        );
    });
});
