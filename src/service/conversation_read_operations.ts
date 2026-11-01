/**
 * The conversation read operations (S-002 R-12, R-11, R-13): list, get, stored entries and current context. They
 * only read, so no call changes a conversation or a daemon document.
 */
import type { Admission, AdmissionSnapshot } from "../admission/admission.ts";
import {
    type ConversationInfo,
    type HarnessHost,
    type HostEntry,
    HostInvalidCursorError,
} from "../host/harness_host.ts";
import { type Origin, readConversationMeta, SEAT_RECORD_KIND, type SeatSummary } from "../host/seating.ts";
import type { Seat } from "../roles/role_model.ts";
import { type AttributedEntry, attributeEntries } from "./attribution.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

export type ConversationStatus = "waiting for a worker thread" | "running" | "parked" | "idle";

export type ConversationListing = {
    id: string;
    jobId: string | null;
    isLead: boolean;
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
type EntriesInput = ConversationRef & { after?: string; limit: number };
type ListInput = { jobId?: string };

const DEFAULT_ENTRIES_LIMIT = 100;
const MIN_ENTRIES_LIMIT = 1;
const MAX_ENTRIES_LIMIT = 500;

export function conversationStatus(
    info: { id: string; busy: boolean; isParked?: boolean },
    admission: AdmissionSnapshot,
): ConversationStatus {
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
    const status = conversationStatus({ ...info, isParked: meta?.parked != null }, admission.state());
    return {
        id: info.id,
        jobId: meta?.jobId ?? null,
        isLead: meta?.isLead ?? false,
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
    const { after, limit = DEFAULT_ENTRIES_LIMIT } = asRecord(raw);
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < MIN_ENTRIES_LIMIT || limit > MAX_ENTRIES_LIMIT)
        throw new Error(`limit must be an integer from ${MIN_ENTRIES_LIMIT} to ${MAX_ENTRIES_LIMIT}`);
    if (after !== undefined && typeof after !== "string") throw new Error("after must be a string");
    return { ...parseConversationRef(raw), limit, ...(after !== undefined && { after }) };
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
                status: conversationStatus({ ...info, isParked: meta?.parked != null }, state),
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

const entriesOperation = defineOperation<ReadContext, EntriesInput, { entries: AttributedEntry[]; next?: string }>({
    name: "conversations.entries",
    kind: "read",
    parse: parseEntriesInput,
    async run({ host }, { conversationId, after, limit }) {
        await requireConversation(host, conversationId);
        try {
            const page = await host.readEntries(conversationId, after === undefined ? { limit } : { after, limit });
            const firstEntry = page.entries[0];
            const prefix =
                after === undefined || firstEntry === undefined
                    ? []
                    : await seatRecordBefore(host, conversationId, firstEntry.id);
            return { ...page, entries: attributeEntries([...prefix, ...page.entries]).slice(prefix.length) };
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
