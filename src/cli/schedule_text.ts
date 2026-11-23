/**
 * The text the `bob schedules` commands print (S-007 REQ-011). Pure: each function turns service answers into text.
 * Every value an entry, a job or a skipped fire holds goes through `terminal_text.ts`: a one-line format takes it with
 * `flat`, and a value that may hold several lines (a request, a reason, a justification) takes `continued`, so no line
 * of data starts at the margin or where a line of the run history starts.
 */
import type { Job, ScheduleRunItem } from "../jobs/job_store.ts";
import { continued, flat } from "./terminal_text.ts";

const NOTHING = "(none)";
const STATUS_LABELS = { to_do: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" } as const;

/** One entry of the `schedules.list` and `schedules.get` answers. */
export type ScheduleEntryView = {
    name: string;
    cron: string;
    request: string;
    role?: string;
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
    nextDueTime: string;
    latestScheduledRun?: Job;
};

function statusLabel(job: Job): string {
    return STATUS_LABELS[job.status];
}

function latestRunText(entry: ScheduleEntryView): string {
    const job = entry.latestScheduledRun;
    return job === undefined ? NOTHING : `${flat(job.number)} (${statusLabel(job)})`;
}

/** One line per entry: name, cron expression, next due time and latest scheduled run. */
export function entriesText(list: { schedules: readonly ScheduleEntryView[] }): string {
    return list.schedules
        .map(
            (entry) =>
                `${flat(entry.name)}  ${flat(entry.cron)}  next ${flat(entry.nextDueTime)}  latest ${latestRunText(entry)}`,
        )
        .join("\n");
}

function entryLines({ schedule }: { schedule: ScheduleEntryView }): string[] {
    const lines = [
        flat(schedule.name),
        `Cron: ${flat(schedule.cron)}`,
        `Next due: ${flat(schedule.nextDueTime)}`,
        `Request: ${continued(schedule.request)}`,
    ];
    if (schedule.role !== undefined) lines.push(`Role: ${flat(schedule.role)}`);
    if (schedule.model !== undefined) lines.push(`Model: ${flat(schedule.model)}`);
    if (schedule.thinkingLevel !== undefined) lines.push(`Thinking level: ${flat(schedule.thinkingLevel)}`);
    if (schedule.workspace !== undefined) lines.push(`Workspace: ${flat(schedule.workspace)}`);
    return lines;
}

function runLine(job: Job, firedAt: string): string {
    const origin = job.request.origin;
    const onDemand = origin.kind === "schedule" && origin.onDemand !== undefined ? "  on demand" : "";
    const ended =
        job.resolution === undefined
            ? ""
            : `  ${flat(job.resolution.kind)} - ${continued(job.resolution.justification)}`;
    return `  ${flat(job.number)}  ${flat(firedAt)}${onDemand}  ${statusLabel(job)}${ended}`;
}

function skipLine({ skip }: { skip: Extract<ScheduleRunItem, { kind: "skip" }>["skip"] }): string {
    const openRun = skip.openRun === null ? "" : ` (open run ${flat(skip.openRun)})`;
    return `  skipped  ${flat(skip.dueTime)}  ${continued(skip.reason)}${openRun}`;
}

/** The entry's values and next due time, then its recent run history. */
export function entryText(entry: { schedule: ScheduleEntryView }, runs: { items: readonly ScheduleRunItem[] }): string {
    const lines = [...entryLines(entry), "Runs:"];
    for (const item of runs.items) lines.push(item.kind === "run" ? runLine(item.job, item.firedAt) : skipLine(item));
    if (runs.items.length === 0) lines.push(`  ${NOTHING}`);
    return lines.join("\n");
}
