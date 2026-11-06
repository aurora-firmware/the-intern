/** The Board's decision logic (S-006 REQ-002): columns, instance feed deltas and older Done jobs. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    addDoneJobs,
    applyJobDelta,
    type BoardJob,
    blockedText,
    boardColumns,
    type JobDelta,
} from "../../web/ui/model/board.ts";

const DONE = { kind: "completed", justification: "all checks pass" } as const;

const job = (number: string, status: BoardJob["status"], extra: Partial<BoardJob> = {}): BoardJob => ({
    number,
    title: `Job ${number}`,
    status,
    ...extra,
});

const numbersOf = (state: ReturnType<typeof boardColumns>, status: BoardJob["status"]): string[] =>
    (state.find((column) => column.status === status)?.jobs ?? []).map((entry) => entry.number);

describe("boardColumns", () => {
    it("places each job in the column of its status, in the order To do, In progress, Blocked, Done", () => {
        const columns = boardColumns([
            job("A1", "done"),
            job("B1", "blocked"),
            job("C1", "to_do"),
            job("D1", "in_progress"),
        ]);
        assert.deepEqual(
            columns.map((column) => column.status),
            ["to_do", "in_progress", "blocked", "done"],
        );
        assert.deepEqual(numbersOf(columns, "to_do"), ["C1"]);
        assert.deepEqual(numbersOf(columns, "in_progress"), ["D1"]);
        assert.deepEqual(numbersOf(columns, "blocked"), ["B1"]);
        assert.deepEqual(numbersOf(columns, "done"), ["A1"]);
    });

    it("keeps the order jobs came in within a column", () => {
        const columns = boardColumns([job("A2", "done"), job("A1", "done")]);
        assert.deepEqual(numbersOf(columns, "done"), ["A2", "A1"]);
    });

    it("returns four empty columns when there are no jobs", () => {
        const columns = boardColumns([]);
        assert.equal(columns.length, 4);
        assert.ok(columns.every((column) => column.jobs.length === 0));
    });
});

describe("applyJobDelta", () => {
    const start = (): ReturnType<typeof boardColumns> =>
        boardColumns([job("T1", "to_do"), job("P1", "in_progress"), job("D2", "done"), job("D1", "done")]);

    it("moves a job to Blocked with its reason on a status change to Blocked", () => {
        const delta: JobDelta = {
            type: "job_status_changed",
            number: "P1",
            old: "in_progress",
            new: "blocked",
            blockedReason: "needs a key",
        };
        const next = applyJobDelta(start(), delta);
        assert.deepEqual(numbersOf(next, "in_progress"), []);
        assert.deepEqual(numbersOf(next, "blocked"), ["P1"]);
        assert.equal(next.find((column) => column.status === "blocked")?.jobs[0]?.blockedReason, "needs a key");
    });

    it("clears the Blocked reason when the job leaves Blocked", () => {
        const blocked = applyJobDelta(start(), {
            type: "job_status_changed",
            number: "P1",
            old: "in_progress",
            new: "blocked",
            blockedReason: "needs a key",
        });
        const next = applyJobDelta(blocked, {
            type: "job_status_changed",
            number: "P1",
            old: "blocked",
            new: "in_progress",
        });
        assert.deepEqual(numbersOf(next, "in_progress"), ["P1"]);
        assert.equal(next.find((column) => column.status === "in_progress")?.jobs[0]?.blockedReason, undefined);
    });

    it("moves a job to the front of Done on job_done", () => {
        const next = applyJobDelta(start(), { type: "job_done", number: "P1", resolution: DONE });
        assert.deepEqual(numbersOf(next, "done"), ["P1", "D2", "D1"]);
        assert.deepEqual(numbersOf(next, "in_progress"), []);
    });

    it("ignores job_done for a job the board does not hold", () => {
        const state = start();
        assert.deepEqual(applyJobDelta(state, { type: "job_done", number: "Z9", resolution: DONE }), state);
    });

    it("adds a created job to its column and leaves the others as they were", () => {
        const state = start();
        const next = applyJobDelta(state, { type: "job_created", job: job("T2", "to_do") });
        assert.deepEqual(numbersOf(next, "to_do"), ["T1", "T2"]);
        assert.deepEqual(numbersOf(next, "in_progress"), ["P1"]);
        assert.deepEqual(numbersOf(next, "done"), ["D2", "D1"]);
    });

    it("holds a created job once when it already arrived", () => {
        const state = start();
        const next = applyJobDelta(state, { type: "job_created", job: job("T1", "to_do") });
        assert.deepEqual(numbersOf(next, "to_do"), ["T1"]);
    });

    it("changes the fields of a changed job and leaves other jobs as they were", () => {
        const state = start();
        const next = applyJobDelta(state, { type: "job_changed", number: "T1", fields: { title: "Renamed" } });
        assert.equal(next.find((column) => column.status === "to_do")?.jobs[0]?.title, "Renamed");
        assert.deepEqual(
            next.find((column) => column.status === "in_progress"),
            state.find((column) => column.status === "in_progress"),
        );
    });

    it("leaves the board as it was on job_related_changed", () => {
        const state = start();
        assert.deepEqual(applyJobDelta(state, { type: "job_related_changed", numbers: ["T1", "P1"] }), state);
    });

    it("does not change the state it was given", () => {
        const state = start();
        const before = structuredClone(state);
        applyJobDelta(state, { type: "job_done", number: "P1", resolution: DONE });
        assert.deepEqual(state, before);
    });
});

describe("addDoneJobs", () => {
    it("appends older Done jobs after the ones held, newest first, and leaves the other columns as they were", () => {
        const state = boardColumns([job("T1", "to_do"), job("D3", "done")]);
        const next = addDoneJobs(state, [job("D2", "done"), job("D1", "done")]);
        assert.deepEqual(numbersOf(next, "done"), ["D3", "D2", "D1"]);
        assert.deepEqual(numbersOf(next, "to_do"), ["T1"]);
    });

    it("holds each short number once when a job came by a delta and by a page", () => {
        const state = applyJobDelta(boardColumns([job("D2", "done")]), {
            type: "job_created",
            job: job("D3", "done"),
        });
        const next = addDoneJobs(state, [job("D3", "done"), job("D2", "done"), job("D1", "done")]);
        assert.deepEqual(numbersOf(next, "done"), ["D3", "D2", "D1"]);
    });
});

describe("blockedText", () => {
    it("gives the reason whole when it is short", () => {
        assert.equal(blockedText(job("B1", "blocked", { blockedReason: "needs a key" })), "needs a key");
    });

    it("gives the start of a long reason", () => {
        const text = blockedText(job("B1", "blocked", { blockedReason: "x".repeat(500) }));
        assert.ok(text.length < 500);
        assert.ok(text.startsWith("xxx"));
        assert.ok(text.endsWith("…"));
    });

    it("gives an empty text when the job has no reason", () => {
        assert.equal(blockedText(job("B1", "blocked")), "");
    });
});
