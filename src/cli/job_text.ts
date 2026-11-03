/**
 * The text the `bob jobs` commands print (S-005 REQ-004). Pure: each function turns a service answer into lines.
 */
import type { JobAuthor, JobStatus } from "../jobs/job_model.ts";
import type { HistoryEntry, Job, WorklogEntry } from "../jobs/job_store.ts";

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
    return `${job.number} created (${statusLabel(job)})`;
}

export function formatJobLine(job: Job): string {
    const reason = job.status === "blocked" && job.blockedReason !== undefined ? ` - ${job.blockedReason}` : "";
    return `${job.number}  ${statusLabel(job)}  ${job.title}${reason}`;
}

function authorText(author: JobAuthor): string {
    if (author.kind === "agent") return `agent ${author.role}`;
    if (author.kind === "team_member") return `team member via ${author.wayIn}`;
    return "daemon";
}

function valueText(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
}

function orNothing(text: string): string {
    return text.trim() === "" ? NOTHING : text;
}

function statusLines(job: Job): string[] {
    const lines = [`Status: ${statusLabel(job)}`];
    if (job.status === "blocked" && job.blockedReason !== undefined) lines.push(`Blocked reason: ${job.blockedReason}`);
    if (job.resolution !== undefined)
        lines.push(`Resolution: ${job.resolution.kind} - ${job.resolution.justification}`);
    return lines;
}

function latest<T>(entries: readonly T[]): readonly T[] {
    return entries.slice(-LATEST_ENTRY_COUNT);
}

export function formatJobDetail({ job, worklog, history }: JobDetail): string[] {
    const lines = [`${job.number}  ${job.title}`, ...statusLines(job)];
    lines.push(`Description: ${orNothing(job.description)}`);
    lines.push(`Definition of done: ${orNothing(job.definitionOfDone)}`);
    lines.push(`Related jobs: ${job.related.length === 0 ? NOTHING : job.related.join(", ")}`);
    lines.push("Worklog:");
    for (const entry of latest(worklog)) lines.push(`  ${entry.at} ${authorText(entry.author)}: ${entry.text}`);
    if (worklog.length === 0) lines.push(`  ${NOTHING}`);
    lines.push("History:");
    for (const entry of latest(history)) {
        const change = `${valueText(entry.old)} -> ${valueText(entry.new)}`;
        lines.push(`  ${entry.at} ${authorText(entry.author)}: ${entry.field}: ${change}`);
    }
    if (history.length === 0) lines.push(`  ${NOTHING}`);
    return lines;
}
