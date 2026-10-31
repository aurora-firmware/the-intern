/**
 * The runtime read operations (S-002 R-12, R-13): a submission's state, waiting for a submission, usage, live
 * pi-durable tasks and the available models. They only read, so no call changes a conversation or a daemon document.
 */
import { MAX_SUBMISSION_WAIT_MS } from "../daemon/constants.ts";
import {
    HostNotFoundError,
    type SubmissionState,
    submissionState,
    waitForSubmission,
} from "../host/conversation_control.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { conversationUsage, type LiveTask, liveTasks, totalUsage, type UsageReport } from "../host/host_inspection.ts";
import type { InternModels } from "../models/model_runtime.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type RuntimeContext = { host: HarnessHost; models: InternModels };
type SubmissionRef = { submissionId: string };
type WaitInput = SubmissionRef & { timeoutMs: number };
type ConversationRef = { conversationId: string };
type ModelSummary = { model: string; thinkingLevels: string[] };

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function parseSubmissionRef(raw: unknown): SubmissionRef {
    const { submissionId } = asRecord(raw);
    if (typeof submissionId !== "string" || submissionId === "")
        throw new Error("submissionId must be a non-empty string");
    return { submissionId };
}

function parseWaitInput(raw: unknown): WaitInput {
    const { timeoutMs } = asRecord(raw);
    if (
        typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > MAX_SUBMISSION_WAIT_MS
    )
        throw new Error(`timeoutMs must be an integer from 0 to ${MAX_SUBMISSION_WAIT_MS}`);
    return { ...parseSubmissionRef(raw), timeoutMs };
}

function parseConversationRef(raw: unknown): ConversationRef {
    const { conversationId } = asRecord(raw);
    if (typeof conversationId !== "string" || conversationId === "")
        throw new Error("conversationId must be a non-empty string");
    return { conversationId };
}

function parseOptionalConversationRef(raw: unknown): { conversationId?: string } {
    if (asRecord(raw).conversationId === undefined) return {};
    return parseConversationRef(raw);
}

async function orNotFound<T>(read: Promise<T>): Promise<T> {
    try {
        return await read;
    } catch (error) {
        if (error instanceof HostNotFoundError) throw new ServiceError("not_found", error.message);
        throw error;
    }
}

const submissionsGet = defineOperation<RuntimeContext, SubmissionRef, SubmissionState>({
    name: "submissions.get",
    kind: "read",
    parse: parseSubmissionRef,
    run: ({ host }, { submissionId }) => orNotFound(submissionState(host, submissionId)),
});

const submissionsWait = defineOperation<RuntimeContext, WaitInput, SubmissionState>({
    name: "submissions.wait",
    kind: "read",
    parse: parseWaitInput,
    run: ({ host }, { submissionId, timeoutMs }) => orNotFound(waitForSubmission(host, submissionId, timeoutMs)),
});

const usageGet = defineOperation<RuntimeContext, { conversationId?: string }, UsageReport>({
    name: "usage.get",
    kind: "read",
    parse: parseOptionalConversationRef,
    run: ({ host }, { conversationId }) =>
        orNotFound(conversationId === undefined ? totalUsage(host) : conversationUsage(host, conversationId)),
});

const tasksLive = defineOperation<RuntimeContext, ConversationRef, LiveTask[]>({
    name: "tasks.live",
    kind: "read",
    parse: parseConversationRef,
    run: ({ host }, { conversationId }) => orNotFound(liveTasks(host, conversationId)),
});

const modelsList = defineOperation<RuntimeContext, Record<string, never>, ModelSummary[]>({
    name: "models.list",
    kind: "read",
    parse: () => ({}),
    run: async ({ models }) => models.listModels(),
});

// biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
export const runtimeReadOperations: readonly Operation<RuntimeContext, any, any>[] = [
    submissionsGet,
    submissionsWait,
    usageGet,
    tasksLive,
    modelsList,
];
