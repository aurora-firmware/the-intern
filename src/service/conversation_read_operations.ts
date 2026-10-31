/**
 * The conversation read operations (S-002 R-12, R-11, R-13): list, get, stored entries and current context. They
 * only read, so no call changes a conversation or a daemon document.
 */
import type { Admission, AdmissionSnapshot } from "../admission/admission.ts";
import { type ConversationInfo, type HarnessHost, type HostEntry, HostInvalidCursorError } from "../host/harness_host.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

export type ConversationStatus = "waiting for a worker thread" | "running" | "idle";

type ReadContext = { host: HarnessHost; admission: Admission };
type ConversationSummary = { id: string; status: ConversationStatus };
type ConversationRef = { conversationId: string };
type EntriesInput = ConversationRef & { after?: string; limit: number };

const DEFAULT_ENTRIES_LIMIT = 100;
const MIN_ENTRIES_LIMIT = 1;
const MAX_ENTRIES_LIMIT = 500;

export function conversationStatus(
    info: { id: string; busy: boolean },
    admission: AdmissionSnapshot,
): ConversationStatus {
    if (admission.waiting.some((waiter) => waiter.conversationId === info.id)) return "waiting for a worker thread";
    return info.busy ? "running" : "idle";
}

function summarize(info: ConversationInfo, admission: Admission): ConversationSummary {
    return { id: info.id, status: conversationStatus(info, admission.state()) };
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

const listOperation = defineOperation<ReadContext, Record<string, never>, ConversationSummary[]>({
    name: "conversations.list",
    kind: "read",
    parse: () => ({}),
    async run({ host, admission }) {
        return (await host.listConversations()).map((info) => summarize(info, admission));
    },
});

const getOperation = defineOperation<ReadContext, ConversationRef, ConversationSummary>({
    name: "conversations.get",
    kind: "read",
    parse: parseConversationRef,
    async run({ host, admission }, { conversationId }) {
        return summarize(await requireConversation(host, conversationId), admission);
    },
});

const entriesOperation = defineOperation<ReadContext, EntriesInput, { entries: HostEntry[]; next?: string }>({
    name: "conversations.entries",
    kind: "read",
    parse: parseEntriesInput,
    async run({ host }, { conversationId, after, limit }) {
        await requireConversation(host, conversationId);
        try {
            return await host.readEntries(conversationId, after === undefined ? { limit } : { after, limit });
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
    entriesOperation,
    contextOperation,
];
