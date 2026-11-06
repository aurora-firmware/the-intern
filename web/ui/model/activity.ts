/**
 * The live activity model (S-006 REQ-005, REQ-014): how entries from a read and from a delta merge, how a tab catches
 * up after a reopen, `lagging` or a restart, how long output collapses and which entry is a held notice. It imports
 * nothing, so Node tests it without a DOM.
 */

/** One conversation entry as `conversations.entries` and the feed's deltas send it. */
export type ActivityEntry = { id: string; kind: string; data: unknown };

/** The input of one `conversations.entries` read the catch-up makes. */
export type EntriesRead = { order: "descending"; limit: number; after?: string };

export type EntriesPage = { entries: ActivityEntry[]; next?: string };

/** The part of a conversation snapshot the catch-up compares. */
export type ActivitySnapshot = { newestEntryId: string | null };

const PAGE_LIMIT = 200;
const COLLAPSE_LINES = 20;
const COLLAPSE_BYTES = 2048;
const PREVIEW_LINES = 5;
const PREVIEW_BYTES = 1024;
const HELD_NOTICE = "held until it continues";
const STEER_KIND = "intern.steer";

/** Compares ids as numbers: as strings, "10" would sort before "9". */
const compareIds = (left: string, right: string): number => {
    const difference = BigInt(left) - BigInt(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

/** Merges entries by id, keeping each once, in numeric id order. The inputs stay unchanged. */
export const mergeEntries = (known: readonly ActivityEntry[], added: readonly ActivityEntry[]): ActivityEntry[] => {
    const byId = new Map<string, ActivityEntry>();
    for (const each of [...known, ...added]) {
        if (!byId.has(each.id)) {
            byId.set(each.id, each);
        }
    }
    return [...byId.values()].sort((left, right) => compareIds(left.id, right.id));
};

const newestId = (entries: readonly ActivityEntry[]): string | undefined =>
    entries.reduce<string | undefined>(
        (newest, each) => (newest === undefined || compareIds(each.id, newest) > 0 ? each.id : newest),
        undefined,
    );

/**
 * Brings the entries shown up to the snapshot. Reads nothing when the snapshot's newest id is the newest shown (or
 * there is none and nothing is shown). Otherwise it reads newest first, a page of 200 at a time, until a page reaches
 * an entry already shown. With nothing shown it reads one page only, so opening a long job never reads it all.
 */
export const catchUp = async (
    known: readonly ActivityEntry[],
    snapshot: ActivitySnapshot,
    readPage: (read: EntriesRead) => Promise<EntriesPage>,
): Promise<ActivityEntry[]> => {
    if (snapshot.newestEntryId === (newestId(known) ?? null)) {
        return [...known];
    }
    const knownIds = new Set(known.map((each) => each.id));
    let merged = [...known];
    let after: string | undefined;
    for (;;) {
        const page = await readPage(
            after === undefined
                ? { order: "descending", limit: PAGE_LIMIT }
                : { order: "descending", limit: PAGE_LIMIT, after },
        );
        const reachedAt = page.entries.findIndex((each) => knownIds.has(each.id));
        const isReachedKnown = reachedAt !== -1;
        merged = mergeEntries(merged, isReachedKnown ? page.entries.slice(0, reachedAt) : page.entries);
        if (known.length === 0 || isReachedKnown || page.next === undefined) {
            return merged;
        }
        after = page.next;
    }
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const lineCount = (text: string): number => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;

/** The longest start of `text` within `limit` bytes, never cutting a character in two. */
const clipToBytes = (text: string, limit: number): string => {
    let clipped = "";
    let used = 0;
    for (const character of text) {
        used += byteLength(character);
        if (used > limit) {
            break;
        }
        clipped += character;
    }
    return clipped;
};

/** Collapses a text above 20 lines or 2 KiB to its first lines; a shorter text stays whole. */
export const collapseOutput = (text: string): { isCollapsed: boolean; shown: string } => {
    if (lineCount(text) <= COLLAPSE_LINES && byteLength(text) <= COLLAPSE_BYTES) {
        return { isCollapsed: false, shown: text };
    }
    const firstLines = text.split("\n").slice(0, PREVIEW_LINES).join("\n");
    return { isCollapsed: true, shown: clipToBytes(firstLines, PREVIEW_BYTES) };
};

/** "held until it continues" for an `intern.steer` record with no `content`; otherwise nothing. */
export const heldNotice = (entry: ActivityEntry): string | undefined => {
    if (entry.kind !== STEER_KIND) {
        return undefined;
    }
    const data = entry.data as { content?: unknown } | null;
    return data?.content === undefined ? HELD_NOTICE : undefined;
};
