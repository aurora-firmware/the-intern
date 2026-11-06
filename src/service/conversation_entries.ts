/**
 * Reading a conversation's stored entries (S-006 Interfaces, `conversations.entries`), oldest first or newest first, each
 * assistant entry attributed to the seat that produced it.
 */
import type { EntryOrder, HarnessHost, HostEntry } from "../host/harness_host.ts";
import { readConversationMeta, SEAT_RECORD_KIND, type SeatRecord, type SeatSummary } from "../host/seating.ts";
import type { Seat } from "../roles/role_model.ts";
import { type AttributedEntry, attributeEntries } from "./attribution.ts";

export type EntriesInput = { conversationId: string; after?: string; limit: number; order: EntryOrder };
type EntriesPage = { entries: AttributedEntry[]; next?: string };

export const MAX_ENTRIES_LIMIT = 500;

export function summarizeSeat(seat: Seat): SeatSummary {
    return {
        role: seat.role,
        model: seat.model,
        ...(seat.thinkingLevel !== undefined && { thinkingLevel: seat.thinkingLevel }),
        workspace: seat.workspace,
    };
}

// An assistant entry on a later page takes its seat from the latest seat record before that page.
async function seatRecordBefore(host: HarnessHost, conversationId: string, firstEntryId: string): Promise<HostEntry[]> {
    let latest: HostEntry | undefined;
    let cursor: string | undefined;
    do {
        const page = await host.readEntries(conversationId, {
            limit: MAX_ENTRIES_LIMIT,
            ...(cursor !== undefined && { after: cursor }),
        });
        for (const entry of page.entries) {
            if (entry.id === firstEntryId) return latest === undefined ? [] : [latest];
            if (entry.kind === SEAT_RECORD_KIND) latest = entry;
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return latest === undefined ? [] : [latest];
}

const ASSISTANT_ENTRY_KIND = "pi.assistant";

// The seat the latest seat record of the transcript made current, or none while the conversation has no seat.
function currentSeatOf(meta: Awaited<ReturnType<typeof readConversationMeta>>): SeatSummary | undefined {
    return meta === undefined || meta.seat.model === "" ? undefined : summarizeSeat(meta.seat);
}

// A descending page below the first takes its seat from the nearest seat record newer than the page: that record's
// `previous`, or the current seat when no seat record is newer.
async function seatAtPageTop(
    host: HarnessHost,
    conversationId: string,
    firstEntryId: string,
    currentSeat: SeatSummary | undefined,
): Promise<SeatSummary | undefined> {
    let nearest: HostEntry | undefined;
    let cursor: string | undefined;
    do {
        const page = await host.readEntries(conversationId, {
            limit: MAX_ENTRIES_LIMIT,
            order: "descending",
            ...(cursor !== undefined && { after: cursor }),
        });
        for (const entry of page.entries) {
            if (entry.id === firstEntryId) return nearest === undefined ? currentSeat : seatBefore(nearest);
            if (entry.kind === SEAT_RECORD_KIND) nearest = entry;
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return nearest === undefined ? currentSeat : seatBefore(nearest);
}

function seatBefore(seatRecord: HostEntry): SeatSummary | undefined {
    return (seatRecord.data as SeatRecord).previous ?? undefined;
}

// Walking newest to oldest, a seat record hands the seat over to the entries before it.
function attributeDescending(entries: HostEntry[], topSeat: SeatSummary | undefined): AttributedEntry[] {
    let seat = topSeat;
    return entries.map((entry) => {
        if (entry.kind === SEAT_RECORD_KIND) seat = seatBefore(entry);
        if (entry.kind !== ASSISTANT_ENTRY_KIND || seat === undefined) return entry;
        return { ...entry, seat };
    });
}

async function readDescending(host: HarnessHost, { conversationId, after, limit }: EntriesInput): Promise<EntriesPage> {
    const page = await host.readEntries(conversationId, {
        limit,
        order: "descending",
        ...(after !== undefined && { after }),
    });
    const currentSeat = currentSeatOf(await readConversationMeta(host, conversationId));
    const firstEntry = page.entries[0];
    const topSeat =
        after === undefined || firstEntry === undefined
            ? currentSeat
            : await seatAtPageTop(host, conversationId, firstEntry.id, currentSeat);
    return { ...page, entries: attributeDescending(page.entries, topSeat) };
}

async function readAscending(host: HarnessHost, { conversationId, after, limit }: EntriesInput): Promise<EntriesPage> {
    const page = await host.readEntries(conversationId, after === undefined ? { limit } : { after, limit });
    const firstEntry = page.entries[0];
    const prefix =
        after === undefined || firstEntry === undefined
            ? []
            : await seatRecordBefore(host, conversationId, firstEntry.id);
    return { ...page, entries: attributeEntries([...prefix, ...page.entries]).slice(prefix.length) };
}

export function readEntriesPage(host: HarnessHost, input: EntriesInput): Promise<EntriesPage> {
    return input.order === "descending" ? readDescending(host, input) : readAscending(host, input);
}
