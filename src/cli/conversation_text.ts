/**
 * The text the `bob conversations` commands print (S-005 REQ-011). Pure: each function turns a service answer into
 * lines. Imports types only, so no daemon code loads.
 */
import type { SeatActor, SeatRecord, SeatSummary } from "../host/seating.ts";
import type { ConversationListing, InvocationTree } from "../service/conversation_read_operations.ts";

type TranscriptEntry = { id: string; kind: string; data: unknown; seat?: SeatSummary };

const MAX_TEXT_LENGTH = 200;
const NO_VALUE = "-";

function seatText(seat: SeatSummary | null): string {
    return seat === null ? NO_VALUE : `${seat.role} (${seat.model})`;
}

function placeText(listing: ConversationListing): string {
    if (listing.isFrontDesk) return "front desk";
    if (listing.jobId === null) return "no job";
    return `job ${listing.jobId}${listing.isLead ? " lead" : ""}`;
}

export function formatConversationLine(listing: ConversationListing): string {
    const activity = listing.lastActivity ?? NO_VALUE;
    return `${listing.id}  ${placeText(listing)}  ${seatText(listing.seat)}  ${listing.status}  ${activity}`;
}

function actorText(actor: SeatActor): string {
    if (actor.kind === "team_member") return `team member via ${actor.wayIn}`;
    if (actor.kind === "agent") return `agent ${actor.role}`;
    if (actor.kind === "job_source") return `job source ${actor.source}`;
    return "daemon";
}

function oneLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > MAX_TEXT_LENGTH ? `${flat.slice(0, MAX_TEXT_LENGTH)}...` : flat;
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
    const previous = record.previous === null ? NO_VALUE : record.previous.role;
    const mode = record.contextMode === undefined ? "" : `, ${record.contextMode} context`;
    const note = record.note === undefined ? "" : `, note: ${oneLine(record.note)}`;
    return `seat: ${previous} -> ${record.next.role} (${record.next.model}) by ${actorText(record.actor)}${mode}${note}`;
}

function formatEntry(entry: TranscriptEntry): string {
    const { kind, data } = entry;
    if (kind === "intern.seat") return seatRecordText(data as SeatRecord);
    if (kind === "pi.user") return `user: ${messageText(data)}`;
    if (kind === "pi.assistant") {
        const role = entry.seat === undefined ? "" : ` (${entry.seat.role})`;
        return `assistant${role}: ${messageText(data)}`;
    }
    if (kind === "intern.steer") {
        const record = data as { actor: SeatActor; mode: string; content?: string };
        return `${record.mode} from ${actorText(record.actor)}: ${oneLine(record.content ?? "")}`;
    }
    if (kind === "intern.report") {
        const record = data as { actor: SeatActor; content: string };
        return `report from ${actorText(record.actor)}: ${oneLine(record.content)}`;
    }
    if (kind === "pi.reset") return "reset";
    if (kind === "pi.compaction") return "compaction";
    return kind;
}

export function formatTranscript(entries: readonly TranscriptEntry[]): string[] {
    return entries.map(formatEntry);
}

export function formatInvocations(tree: InvocationTree, depth = 0): string[] {
    const line = `${"  ".repeat(depth)}${tree.id}  ${tree.role ?? NO_VALUE}  ${tree.status}`;
    return [line, ...tree.invoked.flatMap((child) => formatInvocations(child, depth + 1))];
}

export function formatSeat(seat: { role: string; model: string; thinkingLevel?: string; workspace: string }): string {
    const thinking = seat.thinkingLevel === undefined ? "" : `, thinking ${seat.thinkingLevel}`;
    return `${seat.role} (${seat.model}${thinking}, workspace ${seat.workspace})`;
}
