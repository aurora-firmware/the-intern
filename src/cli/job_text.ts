/**
 * The text the `bob jobs` commands print (S-005 REQ-004). Pure: each function turns a service answer into lines. Data
 * goes through `terminal_text.ts`: a one-line format takes it with `flat`; `bob jobs show` prints multi-line data (a
 * description, a worklog entry) with `continued`, which indents the lines after the first by four spaces, so no line of
 * data starts where a line of the listing starts (the margin, or the two spaces of a worklog or history entry).
 */
import type { JobAuthor, JobStatus } from "../jobs/job_model.ts";
import type { HistoryEntry, Job, WorklogEntry } from "../jobs/job_store.ts";
import { continued, flat } from "./terminal_text.ts";

const STATUS_LABELS: Record<JobStatus, string> = {
    to_do: "To do",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};
const LATEST_ENTRY_COUNT = 10;
const NOTHING = "(none)";

export type JobDetail = {
    job: Job;
    worklog: readonly WorklogEntry[];
    history: readonly HistoryEntry[];
};

export function statusLabel(job: Job): string {
    return STATUS_LABELS[job.status];
}

export function formatCreated(job: Job): string {
    return `${flat(job.number)} created (${statusLabel(job)})`;
}

export function formatJobLine(job: Job): string {
    const reason = job.status === "blocked" && job.blockedReason !== undefined ? ` - ${flat(job.blockedReason)}` : "";
    return `${flat(job.number)}  ${statusLabel(job)}  ${flat(job.title)}${reason}`;
}

function authorText(author: JobAuthor): string {
    if (author.kind === "agent") return `agent ${flat(author.role)}`;
    if (author.kind === "team_member") return `team member via ${flat(author.wayIn)}`;
    return "daemon";
}

function valueText(value: unknown): string {
    return flat(typeof value === "string" ? value : JSON.stringify(value));
}

function orNothing(text: string): string {
    return text.trim() === "" ? NOTHING : continued(text);
}

function statusLines(job: Job): string[] {
    const lines = [`Status: ${statusLabel(job)}`];
    if (job.status === "blocked" && job.blockedReason !== undefined)
        lines.push(`Blocked reason: ${continued(job.blockedReason)}`);
    if (job.resolution !== undefined)
        lines.push(`Resolution: ${flat(job.resolution.kind)} - ${continued(job.resolution.justification)}`);
    return lines;
}

function latest<T>(entries: readonly T[]): readonly T[] {
    return entries.slice(-LATEST_ENTRY_COUNT);
}

export function formatJobDetail({ job, worklog, history }: JobDetail): string[] {
    const lines = [`${flat(job.number)}  ${flat(job.title)}`, ...statusLines(job)];
    lines.push(`Description: ${orNothing(job.description)}`);
    lines.push(`Definition of done: ${orNothing(job.definitionOfDone)}`);
    lines.push(`Related jobs: ${job.related.length === 0 ? NOTHING : flat(job.related.join(", "))}`);
    lines.push("Worklog:");
    for (const entry of latest(worklog))
        lines.push(`  ${flat(entry.at)} ${authorText(entry.author)}: ${continued(entry.text)}`);
    if (worklog.length === 0) lines.push(`  ${NOTHING}`);
    lines.push("History:");
    for (const entry of latest(history)) {
        const change = `${valueText(entry.old)} -> ${valueText(entry.new)}`;
        lines.push(`  ${flat(entry.at)} ${authorText(entry.author)}: ${flat(entry.field)}: ${change}`);
    }
    if (history.length === 0) lines.push(`  ${NOTHING}`);
    return lines;
}
