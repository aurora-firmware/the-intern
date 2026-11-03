/**
 * The lines `bob follow` prints for the instance feed (S-005 REQ-007). Pure: a delta becomes a line, or nothing when
 * the feed event is not one the command reports. Imports types only, so no daemon code loads.
 */
import type { InstanceDelta } from "../feed/instance_feed.ts";
import type { JobStatus } from "../jobs/job_model.ts";

const STATUS_LABELS: Record<JobStatus, string> = {
    to_do: "To do",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};

function statusChangeLine(delta: Extract<InstanceDelta, { type: "job_status_changed" }>): string {
    const { number, old, blockedReason } = delta;
    if (delta.new === "blocked") return `${number} blocked: ${blockedReason ?? "no reason given"}`;
    if (old === "blocked" && delta.new === "in_progress") return `${number} resumed`;
    return `${number} ${STATUS_LABELS[old]} -> ${STATUS_LABELS[delta.new]}`;
}

/** The line for a delta of the instance feed, or undefined for an event the command doesn't report. */
export function instanceEventLine(delta: unknown): string | undefined {
    const event = delta as InstanceDelta;
    switch (event.type) {
        case "job_created":
            return `${event.job.number} created (${STATUS_LABELS[event.job.status]})`;
        case "job_status_changed":
            return statusChangeLine(event);
        case "job_done":
            return `${event.number} done (${event.resolution.kind}): ${event.resolution.justification}`;
        case "run_started":
            return `Agent run started in conversation ${event.conversationId}`;
        case "run_finished":
            return `Agent run finished in conversation ${event.conversationId}`;
        default:
            return undefined;
    }
}
