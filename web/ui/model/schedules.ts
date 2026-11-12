/**
 * The Schedules page's decision logic (S-007 REQ-012): which instance feed deltas make the page read the entries again,
 * and how a skipped fire joins an entry's history. It imports only the Board's job delta type, so Node tests it
 * without a DOM.
 */

import type { JobDelta } from "./board.ts";

/** A fire that created no job, as the feed's `schedule_fire_skipped` delta carries it. */
export type ScheduleSkip = { entry: string; dueTime: string; reason: string; openRun: string | null };

/** One item of an entry's history: a scheduled run, or a skipped fire. */
export type ScheduleHistoryItem =
    | { kind: "run"; firedAt: string; jobNumber: string }
    | { kind: "skip"; skip: ScheduleSkip };

/** What the page holds of an entry: its name and its recent history, newest first. */
export type ScheduleCard = { name: string; history: ScheduleHistoryItem[] };

export type SchedulesState = ScheduleCard[];

/** The deltas the page looks at. Declared here so the page imports no daemon type. */
export type ScheduleDelta =
    | JobDelta
    | { type: "settings_changed"; section: string }
    | { type: "schedule_fire_skipped"; entry: string; dueTime: string; reason: string; openRun?: string };

const SCHEDULED_RUN_LETTER = "S";

const isScheduledRun = (number: string): boolean => number.startsWith(SCHEDULED_RUN_LETTER);

/** Whether the delta is one after which the page reads `schedules.list` again. */
export const shouldRereadSchedules = (delta: ScheduleDelta): boolean => {
    switch (delta.type) {
        case "settings_changed":
            return delta.section === "schedule";
        case "job_created":
            return isScheduledRun(delta.job.number);
        case "job_changed":
        case "job_status_changed":
        case "job_done":
            return isScheduledRun(delta.number);
        case "job_related_changed":
            return delta.numbers.some(isScheduledRun);
        case "schedule_fire_skipped":
            return false;
    }
};

const isSameSkip = (item: ScheduleHistoryItem, skip: ScheduleSkip): boolean =>
    item.kind === "skip" && item.skip.entry === skip.entry && item.skip.dueTime === skip.dueTime;

/** Puts a skipped fire first in its entry's history, once. Any other delta, or an entry not held, changes nothing. */
export const addSkip = (state: SchedulesState, delta: ScheduleDelta): SchedulesState => {
    if (delta.type !== "schedule_fire_skipped") {
        return state;
    }
    const skip: ScheduleSkip = {
        entry: delta.entry,
        dueTime: delta.dueTime,
        reason: delta.reason,
        openRun: delta.openRun ?? null,
    };
    return state.map((card) => {
        if (card.name !== skip.entry || card.history.some((item) => isSameSkip(item, skip))) {
            return card;
        }
        return { name: card.name, history: [{ kind: "skip", skip }, ...card.history] };
    });
};

/** Applies each delta in order with `addSkip`: the skips seen while a read was in flight rejoin what the read returned. */
export const addSkips = (state: SchedulesState, deltas: readonly ScheduleDelta[]): SchedulesState =>
    deltas.reduce(addSkip, state);
