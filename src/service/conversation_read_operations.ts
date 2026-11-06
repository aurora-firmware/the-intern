/**
 * The conversation read operations (S-002 REQ-012, REQ-011, REQ-013): list, get, stored entries and current context.
 * They only read, so no call changes a conversation or a daemon document.
 */
import type { Admission, AdmissionSnapshot } from "../admission/admission.ts";
import {
    type ConversationInfo,
    type EntryOrder,
    type HarnessHost,
    type HostEntry,
    HostInvalidCursorError,
} from "../host/harness_host.ts";
import {
    type Origin,
    readConversationMeta,
    SEAT_RECORD_KIND,
    type SeatRecord,
    type SeatSummary,
} from "../host/seating.ts";
import type { Seat } from "../roles/role_model.ts";
import { type AttributedEntry, attributeEntries } from "./attribution.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

export type ConversationStatus = "closed" | "waiting for a worker thread" | "running" | "parked" | "idle";

export type ConversationListing = {
    id: string;
    jobId: string | null;
    isLead: boolean;
    isFrontDesk: boolean;
    seat: SeatSummary | null;
    origin: Origin | null;
    status: ConversationStatus;
    lastActivity: string | null;
    invokedBy?: string;
    depth: number;
};
export type InvocationTree = { id: string; role: string | null; status: ConversationStatus; invoked: InvocationTree[] };

type ReadContext = { host: HarnessHost; admission: Admission };
type ConversationRef = { conversationId: string };
type EntriesInput = ConversationRef & { after?: string; limit: number; order: EntryOrder };
type ListInput = { jobId?: string };

const DEFAULT_ENTRIES_LIMIT = 100;
const MIN_ENTRIES_LIMIT = 1;
const MAX_ENTRIES_LIMIT = 500;

export function conversationStatus(
    info: { id: string; busy: boolean; isParked?: boolean; isClosed?: boolean },
    admission: AdmissionSnapshot,
): ConversationStatus {
    // A closed conversation stays closed whatever else is true of it, a run its abort hasn't ended yet included.
    if (info.isClosed === true) return "closed";
    if (admission.waiting.some((waiter) => waiter.conversationId === info.id)) return "waiting for a worker thread";
    if (info.busy) return "running";
    return info.isParked === true ? "parked" : "idle";
}

async function lastActivityOf(host: HarnessHost, conversationId: string): Promise<string | null> {
    const newest = await host.readLastMessageTime(conversationId);
    return newest === null ? null : new Date(newest).toISOString();
}

async function listingOf(
    host: HarnessHost,
    admission: Admission,
    info: ConversationInfo,
): Promise<ConversationListing> {
    const meta = await readConversationMeta(host, info.id);
    const status = conversationStatus(
        { ...info, isParked: meta?.parked != null, isClosed: meta?.closed === true },
        admission.state(),
    );
    return {
        id: info.id,
        jobId: meta?.jobId ?? null,
        isLead: meta?.isLead ?? false,
        isFrontDesk: meta?.origin.kind === "front_desk",
        seat: meta === undefined ? null : summarizeSeat(meta.seat),
        origin: meta?.origin ?? null,
        status,
        lastActivity: await lastActivityOf(host, info.id),
        ...(meta?.invokedBy !== undefined && { invokedBy: meta.invokedBy }),
        depth: meta?.depth ?? 0,
    };
}

function summarizeSeat(seat: Seat): SeatSummary {
    return {
        role: seat.role,
        model: seat.model,
        ...(seat.thinkingLevel !== undefined && { thinkingLevel: seat.thinkingLevel }),
        workspace: seat.workspace,
    };
}

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function parseConversationRef(raw: unknown): ConversationRef {
    const { conversationId } = asRecord(raw);
    if (typeof conversationId !== "string" || conversationId === "")
        throw new Error("conversationId must be a non-empty string");
    return { conversationId };
}

function parseEntriesInput(raw: unknown): EntriesInput {
    const { after, limit = DEFAULT_ENTRIES_LIMIT, order = "ascending" } = asRecord(raw);
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < MIN_ENTRIES_LIMIT || limit > MAX_ENTRIES_LIMIT)
        throw new Error(`limit must be an integer from ${MIN_ENTRIES_LIMIT} to ${MAX_ENTRIES_LIMIT}`);
    if (after !== undefined && typeof after !== "string") throw new Error("after must be a string");
    if (order !== "ascending" && order !== "descending") throw new Error('order must be "ascending" or "descending"');
    return { ...parseConversationRef(raw), limit, order, ...(after !== undefined && { after }) };
}

async function requireConversation(host: HarnessHost, conversationId: string): Promise<ConversationInfo> {
    const info = await host.conversationInfo(conversationId);
    if (!info) throw new ServiceError("not_found", `Conversation ${conversationId} does not exist`);
    return info;
}

function parseListInput(raw: unknown): ListInput {
    const { jobId } = asRecord(raw);
    if (jobId !== undefined && (typeof jobId !== "string" || jobId === "")) {
        throw new Error("jobId must be a non-empty string");
    }
    return jobId === undefined ? {} : { jobId };
}

const listOperation = defineOperation<ReadContext, ListInput, ConversationListing[]>({
    name: "conversations.list",
    kind: "read",
    parse: parseListInput,
    async run({ host, admission }, { jobId }) {
        const listings: ConversationListing[] = [];
        for (const info of await host.listConversations()) {
            if (jobId !== undefined && (await readConversationMeta(host, info.id))?.jobId !== jobId) continue;
            listings.push(await listingOf(host, admission, info));
        }
        return listings;
    },
});

const getOperation = defineOperation<ReadContext, ConversationRef, ConversationListing>({
    name: "conversations.get",
    kind: "read",
    parse: parseConversationRef,
    async run({ host, admission }, { conversationId }) {
        return listingOf(host, admission, await requireConversation(host, conversationId));
    },
});

async function buildInvocationTree(
    node: ConversationInfo,
    childrenOf: Map<string, ConversationInfo[]>,
    describe: (info: ConversationInfo) => Promise<{ role: string | null; status: ConversationStatus }>,
): Promise<InvocationTree> {
    const invoked: InvocationTree[] = [];
    for (const child of childrenOf.get(node.id) ?? [])
        invoked.push(await buildInvocationTree(child, childrenOf, describe));
    return { id: node.id, ...(await describe(node)), invoked };
}

const invocationsOperation = defineOperation<ReadContext, ConversationRef, InvocationTree>({
    name: "conversations.invocations",
    kind: "read",
    parse: parseConversationRef,
    async run({ host, admission }, { conversationId }) {
        const root = await requireConversation(host, conversationId);
        const childrenOf = new Map<string, ConversationInfo[]>();
        const metaOf = new Map<string, Awaited<ReturnType<typeof readConversationMeta>>>();
        for (const info of await host.listConversations()) {
            const meta = await readConversationMeta(host, info.id);
            metaOf.set(info.id, meta);
            if (meta?.invokedBy === undefined) continue;
            childrenOf.set(meta.invokedBy, [...(childrenOf.get(meta.invokedBy) ?? []), info]);
        }
        const state = admission.state();
        return buildInvocationTree(root, childrenOf, async (info) => {
            const meta = metaOf.get(info.id);
            return {
                role: meta?.seat.role ?? null,
                status: conversationStatus(
                    { ...info, isParked: meta?.parked != null, isClosed: meta?.closed === true },
                    state,
                ),
            };
        });
    },
});

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

async function readDescending(
    host: HarnessHost,
    { conversationId, after, limit }: EntriesInput,
): Promise<{ entries: AttributedEntry[]; next?: string }> {
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

async function readAscending(
    host: HarnessHost,
    { conversationId, after, limit }: EntriesInput,
): Promise<{ entries: AttributedEntry[]; next?: string }> {
    const page = await host.readEntries(conversationId, after === undefined ? { limit } : { after, limit });
    const firstEntry = page.entries[0];
    const prefix =
        after === undefined || firstEntry === undefined
            ? []
            : await seatRecordBefore(host, conversationId, firstEntry.id);
    return { ...page, entries: attributeEntries([...prefix, ...page.entries]).slice(prefix.length) };
}

const entriesOperation = defineOperation<ReadContext, EntriesInput, { entries: AttributedEntry[]; next?: string }>({
    name: "conversations.entries",
    kind: "read",
    parse: parseEntriesInput,
    async run({ host }, input) {
        await requireConversation(host, input.conversationId);
        try {
            return input.order === "descending" ? await readDescending(host, input) : await readAscending(host, input);
        } catch (error) {
            if (error instanceof HostInvalidCursorError) throw new ServiceError("invalid_input", error.message);
            throw error;
        }
    },
});

const contextOperation = defineOperation<ReadContext, ConversationRef, HostEntry[]>({
    name: "conversations.context",
    kind: "read",
    parse: parseConversationRef,
    async run({ host }, { conversationId }) {
        await requireConversation(host, conversationId);
        return host.readContext(conversationId);
    },
});

// biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
export const conversationReadOperations: readonly Operation<ReadContext, any, any>[] = [
    listOperation,
    getOperation,
    invocationsOperation,
    entriesOperation,
    contextOperation,
];
