/** The Schedules page's decision logic (S-007 REQ-012): when the feed makes it read again, and a skipped fire. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    addSkip,
    type ScheduleDelta,
    type ScheduleHistoryItem,
    type SchedulesState,
    shouldRereadSchedules,
} from "../../web/ui/model/schedules.ts";

const jobDelta = (number: string): ScheduleDelta => ({
    type: "job_status_changed",
    number,
    old: "to_do",
    new: "in_progress",
});

const skipDelta = (entry: string, dueTime: string, extra: { openRun?: string } = {}): ScheduleDelta => ({
    type: "schedule_fire_skipped",
    entry,
    dueTime,
    reason: "the entry has an open scheduled run",
    ...extra,
});

const run = (number: string, firedAt: string): ScheduleHistoryItem => ({ kind: "run", firedAt, jobNumber: number });

const skipOf = (state: SchedulesState, entry: string): ScheduleHistoryItem[] =>
    state.find((candidate) => candidate.name === entry)?.history ?? [];

describe("shouldRereadSchedules", () => {
    it("returns true for settings_changed of the schedule section", () => {
        assert.equal(shouldRereadSchedules({ type: "settings_changed", section: "schedule" }), true);
    });

    it("returns true for every job delta of an S number", () => {
        const deltas: ScheduleDelta[] = [
            jobDelta("S3"),
            { type: "job_done", number: "S3", resolution: { kind: "completed", justification: "done" } },
            { type: "job_created", job: { number: "S4", title: "t", status: "to_do" } },
        ];
        assert.deepEqual(deltas.map(shouldRereadSchedules), [true, true, true]);
    });

    it("returns false for settings_changed of another section", () => {
        assert.equal(shouldRereadSchedules({ type: "settings_changed", section: "models" }), false);
    });

    it("returns false for a job delta of another letter", () => {
        const deltas: ScheduleDelta[] = [
            jobDelta("A3"),
            { type: "job_created", job: { number: "U4", title: "t", status: "to_do" } },
        ];
        assert.deepEqual(deltas.map(shouldRereadSchedules), [false, false]);
    });
});

describe("addSkip", () => {
    const state = (): SchedulesState => [
        { name: "nightly", history: [run("S1", "2026-11-07T02:00:00+01:00")] },
        { name: "weekly", history: [] },
    ];

    it("puts the skipped fire first in the history of its entry", () => {
        const history = skipOf(
            addSkip(state(), skipDelta("nightly", "2026-11-08T02:00:00+01:00", { openRun: "S1" })),
            "nightly",
        );
        assert.deepEqual(
            history.map((item) => item.kind),
            ["skip", "run"],
        );
        assert.deepEqual(history[0], {
            kind: "skip",
            skip: {
                entry: "nightly",
                dueTime: "2026-11-08T02:00:00+01:00",
                reason: "the entry has an open scheduled run",
                openRun: "S1",
            },
        });
    });

    it("adds nothing when the same delta arrives again", () => {
        const delta = skipDelta("nightly", "2026-11-08T02:00:00+01:00");
        const once = addSkip(state(), delta);
        assert.deepEqual(addSkip(once, delta), once);
    });

    it("leaves the other entries as they were", () => {
        const after = addSkip(state(), skipDelta("nightly", "2026-11-08T02:00:00+01:00"));
        assert.deepEqual(skipOf(after, "weekly"), []);
    });

    it("ignores a skip of an entry the page doesn't hold, and any other delta", () => {
        const before = state();
        assert.deepEqual(addSkip(before, skipDelta("gone", "2026-11-08T02:00:00+01:00")), before);
        assert.deepEqual(addSkip(before, jobDelta("S1")), before);
    });
});
