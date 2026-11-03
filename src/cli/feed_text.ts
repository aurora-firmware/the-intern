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

/** The line that reports how a job ended. */
export function doneLine(number: string, resolution: { kind: string; justification: string }): string {
    return `${number} done (${resolution.kind}): ${resolution.justification}`;
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
            return doneLine(event.number, event.resolution);
        case "run_started":
            return `Agent run started in conversation ${event.conversationId}`;
        case "run_finished":
            return `Agent run finished in conversation ${event.conversationId}`;
        default:
            return undefined;
    }
}

/** The line `bob jobs follow` prints for a delta about its job: the instance lines, plus edits and worklog entries. */
export function jobEventLine(delta: unknown): string | undefined {
    const event = delta as InstanceDelta;
    switch (event.type) {
        case "job_changed":
            return `${event.number} edited: ${Object.keys(event.fields).join(", ")}`;
        case "job_worklog_added":
            return `${event.number} worklog: ${event.entry.text}`;
        default:
            return instanceEventLine(delta);
    }
}

const MAX_TEXT_LENGTH = 200;

type ContentPart = { type?: string; text?: string; name?: string };
type Message = { content?: unknown; toolName?: string; isError?: boolean };

function oneLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > MAX_TEXT_LENGTH ? `${flat.slice(0, MAX_TEXT_LENGTH)}...` : flat;
}

function messagesOf(data: unknown): Message[] {
    return Array.isArray(data) ? (data as Message[]) : [];
}

function partsOf(message: Message): ContentPart[] {
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return Array.isArray(message.content) ? (message.content as ContentPart[]) : [];
}

function textOf(message: Message): string {
    return partsOf(message)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join(" ");
}

function assistantText(message: Message): string {
    const pieces = partsOf(message).flatMap((part) => {
        if (part.type === "text") return [oneLine(part.text ?? "")];
        if (part.type === "toolCall") return [`calls ${part.name}`];
        return [];
    });
    return pieces.join("; ");
}

function reportLine(data: unknown): string {
    const { actor, content } = data as { actor?: { conversationId?: string; role?: string }; content?: string };
    return `report from conversation ${actor?.conversationId} (${actor?.role}): ${oneLine(content ?? "")}`;
}

/** The line for one entry of a conversation, or undefined for an entry the command doesn't report. */
export function conversationEntryLine(entry: unknown): string | undefined {
    const { kind, data } = entry as { kind?: string; data?: unknown };
    const messages = messagesOf(data);
    switch (kind) {
        case "pi.user":
            return messages.map((message) => `user: ${oneLine(textOf(message))}`).join("\n");
        case "pi.assistant":
            return messages.map((message) => `assistant: ${assistantText(message)}`).join("\n");
        case "pi.tool-result":
            return messages
                .map((message) => `tool ${message.toolName} ${message.isError ? "failed" : "returned"}`)
                .join("\n");
        case "intern.report":
            return reportLine(data);
        default:
            return undefined;
    }
}
