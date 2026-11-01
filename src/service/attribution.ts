/**
 * Attribution (S-001 R-7): every assistant entry of a transcript names the seat that produced it, which is the seat
 * of the latest seat record before it.
 */
import type { HostEntry } from "../host/harness_host.ts";
import { SEAT_RECORD_KIND, type SeatRecord, type SeatSummary } from "../host/seating.ts";

const ASSISTANT_ENTRY_KIND = "pi.assistant";

export type AttributedEntry = HostEntry & { seat?: SeatSummary };

export function attributeEntries(entries: HostEntry[]): AttributedEntry[] {
    let currentSeat: SeatSummary | undefined;
    return entries.map((entry) => {
        if (entry.kind === SEAT_RECORD_KIND) currentSeat = (entry.data as SeatRecord).next;
        if (entry.kind !== ASSISTANT_ENTRY_KIND || currentSeat === undefined) return entry;
        return { ...entry, seat: currentSeat };
    });
}
