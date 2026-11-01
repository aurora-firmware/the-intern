/**
 * The conversation control operations (S-002 R-12, R-13): submit input, withdraw a queued input, abort, reset and
 * compact. They need only the host; the host's errors map to the service error codes.
 */
import {
    type BusyMode,
    compactConversation,
    HostBusyError,
    HostConflictError,
    HostNotFoundError,
    resetConversation,
    submitInput,
    withdrawInput,
} from "../host/conversation_control.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { abortWithAwaited } from "../host/invocation.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type ControlContext = { host: HarnessHost };
type ConversationRef = { conversationId: string };
type SubmitInput = ConversationRef & { content: string; requestId: string; busyMode: BusyMode };
type ResetInput = ConversationRef & { note?: string };
type CompactInput = ConversationRef & { instructions?: string };

const BUSY_MODES: readonly BusyMode[] = ["followUp", "steer", "reject"];
const DEFAULT_BUSY_MODE: BusyMode = "followUp";

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
    return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
    const value = record[field];
    if (value !== undefined && typeof value !== "string") throw new Error(`${field} must be a string`);
    return value;
}

function parseConversationRef(raw: unknown): ConversationRef {
    return { conversationId: requireString(asRecord(raw), "conversationId") };
}

function parseSubmit(raw: unknown): SubmitInput {
    const record = asRecord(raw);
    const busyMode = record.busyMode ?? DEFAULT_BUSY_MODE;
    if (!BUSY_MODES.includes(busyMode as BusyMode)) throw new Error(`busyMode must be one of ${BUSY_MODES.join(", ")}`);
    return {
        ...parseConversationRef(raw),
        content: requireString(record, "content"),
        requestId: requireString(record, "requestId"),
        busyMode: busyMode as BusyMode,
    };
}

function parseReset(raw: unknown): ResetInput {
    const note = optionalString(asRecord(raw), "note");
    return { ...parseConversationRef(raw), ...(note !== undefined && { note }) };
}

function parseCompact(raw: unknown): CompactInput {
    const instructions = optionalString(asRecord(raw), "instructions");
    return { ...parseConversationRef(raw), ...(instructions !== undefined && { instructions }) };
}

async function mappingHostErrors<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof HostNotFoundError) throw new ServiceError("not_found", error.message);
        if (error instanceof HostBusyError) throw new ServiceError("busy", error.message);
        if (error instanceof HostConflictError) throw new ServiceError("conflict", error.message);
        throw error;
    }
}

const submitOperation = defineOperation<ControlContext, SubmitInput, { submissionId: string }>({
    name: "conversations.submit",
    kind: "control",
    parse: parseSubmit,
    run: ({ host }, { conversationId, ...input }) => mappingHostErrors(() => submitInput(host, conversationId, input)),
});

const withdrawOperation = defineOperation<ControlContext, { submissionId: string }, Record<string, never>>({
    name: "submissions.withdraw",
    kind: "control",
    parse: (raw) => ({ submissionId: requireString(asRecord(raw), "submissionId") }),
    run: ({ host }, { submissionId }) =>
        mappingHostErrors(async () => {
            await withdrawInput(host, submissionId);
            return {};
        }),
});

const abortOperation = defineOperation<ControlContext, ConversationRef, Record<string, never>>({
    name: "conversations.abort",
    kind: "control",
    parse: parseConversationRef,
    run: ({ host }, { conversationId }) =>
        mappingHostErrors(async () => {
            await abortWithAwaited(host, conversationId);
            return {};
        }),
});

const resetOperation = defineOperation<ControlContext, ResetInput, Record<string, never>>({
    name: "conversations.reset",
    kind: "control",
    parse: parseReset,
    run: ({ host }, { conversationId, note }) =>
        mappingHostErrors(async () => {
            await resetConversation(host, conversationId, note);
            return {};
        }),
});

const compactOperation = defineOperation<ControlContext, CompactInput, Record<string, never>>({
    name: "conversations.compact",
    kind: "control",
    parse: parseCompact,
    run: ({ host }, { conversationId, instructions }) =>
        mappingHostErrors(async () => {
            await compactConversation(host, conversationId, instructions);
            return {};
        }),
});

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
export const conversationControlOperations: readonly Operation<ControlContext, any, any>[] = [
    submitOperation,
    withdrawOperation,
    abortOperation,
    resetOperation,
    compactOperation,
];
