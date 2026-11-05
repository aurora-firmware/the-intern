/**
 * The text the `bob conversations` commands print (S-005 REQ-011). Pure: each function turns a service answer into
 * lines, each of one line: data goes through `flat`, so it brings no control sequence and no line break. Imports types
 * only, so no daemon code loads.
 */
import type { SeatActor, SeatRecord, SeatSummary } from "../host/seating.ts";
import type { ConversationListing, InvocationTree } from "../service/conversation_read_operations.ts";
import { flat } from "./terminal_text.ts";

type TranscriptEntry = { id: string; kind: string; data: unknown; seat?: SeatSummary };

const MAX_TEXT_LENGTH = 200;
const NO_VALUE = "-";

function seatText(seat: SeatSummary | null): string {
    return seat === null ? NO_VALUE : `${flat(seat.role)} (${flat(seat.model)})`;
}

function placeText(listing: ConversationListing): string {
    if (listing.isFrontDesk) return "front desk";
    if (listing.jobId === null) return "no job";
    return `job ${flat(listing.jobId)}${listing.isLead ? " lead" : ""}`;
}

export function formatConversationLine(listing: ConversationListing): string {
    const activity = flat(listing.lastActivity ?? NO_VALUE);
    return `${flat(listing.id)}  ${placeText(listing)}  ${seatText(listing.seat)}  ${flat(listing.status)}  ${activity}`;
}

function actorText(actor: SeatActor): string {
    if (actor.kind === "team_member") return `team member via ${flat(actor.wayIn)}`;
    if (actor.kind === "agent") return `agent ${flat(actor.role)}`;
    if (actor.kind === "job_source") return `job source ${flat(actor.source)}`;
    return "daemon";
}

function oneLine(text: string): string {
    const line = flat(text);
    return line.length > MAX_TEXT_LENGTH ? `${line.slice(0, MAX_TEXT_LENGTH)}...` : line;
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((block) => (block as { text?: unknown }).text)
        .filter((text) => typeof text === "string")
        .join(" ");
}

// The model messages an entry carries, whose texts make up what the entry says.
function messageText(data: unknown): string {
    if (!Array.isArray(data)) return "";
    return oneLine(data.map((message) => contentText((message as { content?: unknown }).content)).join(" "));
}

function seatRecordText(record: SeatRecord): string {
    const previous = record.previous === null ? NO_VALUE : flat(record.previous.role);
    const mode = record.contextMode === undefined ? "" : `, ${flat(record.contextMode)} context`;
    const note = record.note === undefined ? "" : `, note: ${oneLine(record.note)}`;
    return `seat: ${previous} -> ${flat(record.next.role)} (${flat(record.next.model)}) by ${actorText(record.actor)}${mode}${note}`;
}

function formatEntry(entry: TranscriptEntry): string {
    const { kind, data } = entry;
    if (kind === "intern.seat") return seatRecordText(data as SeatRecord);
    if (kind === "pi.user") return `input: ${messageText(data)}`;
    if (kind === "pi.assistant") {
        const role = entry.seat === undefined ? "" : ` (${flat(entry.seat.role)})`;
        return `assistant${role}: ${messageText(data)}`;
    }
    if (kind === "intern.steer") {
        const record = data as { actor: SeatActor; mode: string; content?: string };
        return `${flat(record.mode)} from ${actorText(record.actor)}: ${oneLine(record.content ?? "")}`;
    }
    if (kind === "intern.report") {
        const record = data as { actor: SeatActor; content: string };
        return `report from ${actorText(record.actor)}: ${oneLine(record.content)}`;
    }
    if (kind === "pi.reset") return "reset";
    if (kind === "pi.compaction") return "compaction";
    return flat(kind);
}

export function formatTranscript(entries: readonly TranscriptEntry[]): string[] {
    return entries.map(formatEntry);
}

export function formatInvocations(tree: InvocationTree, depth = 0): string[] {
    const line = `${"  ".repeat(depth)}${flat(tree.id)}  ${flat(tree.role ?? NO_VALUE)}  ${flat(tree.status)}`;
    return [line, ...tree.invoked.flatMap((child) => formatInvocations(child, depth + 1))];
}

export function formatSeat(seat: { role: string; model: string; thinkingLevel?: string; workspace: string }): string {
    const thinking = seat.thinkingLevel === undefined ? "" : `, thinking ${flat(seat.thinkingLevel)}`;
    return `${flat(seat.role)} (${flat(seat.model)}${thinking}, workspace ${flat(seat.workspace)})`;
}
