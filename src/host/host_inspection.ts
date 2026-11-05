/**
 * Host-side usage and live task reads (S-002 REQ-012). Only `src/host/` calls pi-durable, so the service layer reads
 * spend and unfinished pi-durable tasks through these functions.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HostNotFoundError } from "./conversation_control.ts";
import { parseConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";

const context = BACKGROUND_CONTEXT;
const USAGE_DOCUMENT = "pi.usage";

/** The counters of pi-durable's `Usage`, copied as plain JSON. */
export type UsageTotals = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
export type UsageReport = { models: Record<string, UsageTotals>; tools: Record<string, UsageTotals> };
export type LiveTask = { taskId: string; kind: string; state: string; blockedReason?: string };

function toUsageTotals(usage: UsageTotals): UsageTotals {
    return structuredClone(usage);
}

function toUsageReport(state: { models?: Record<string, UsageTotals>; tools?: Record<string, UsageTotals> }) {
    const copyBucket = (bucket: Record<string, UsageTotals> = {}): Record<string, UsageTotals> =>
        Object.fromEntries(Object.entries(bucket).map(([key, usage]) => [key, toUsageTotals(usage)]));
    return { models: copyBucket(state.models), tools: copyBucket(state.tools) } satisfies UsageReport;
}

async function requireConversationId(host: HarnessHost, id: string): Promise<ConversationId> {
    const numericId = parseConversationId(id);
    const conversation =
        numericId === undefined ? undefined : await internalHarness(host).conversation(numericId, context);
    if (!conversation) throw new HostNotFoundError(`Conversation "${id}" does not exist.`);
    return conversation.id;
}

export async function conversationUsage(host: HarnessHost, id: string): Promise<UsageReport> {
    const conversationId = await requireConversationId(host, id);
    const conversation = await internalHarness(host).conversation(conversationId, context);
    const view = await conversation?.viewState(context);
    try {
        return toUsageReport((view?.value.docs[USAGE_DOCUMENT] ?? {}) as Parameters<typeof toUsageReport>[0]);
    } finally {
        view?.dispose();
    }
}

export async function totalUsage(host: HarnessHost): Promise<UsageReport> {
    return toUsageReport((await internalHarness(host).usage(context)) as Parameters<typeof toUsageReport>[0]);
}

/** The conversation's unfinished tasks. A task parked by the restart limit or a missing definition names why. */
export async function liveTasks(host: HarnessHost, id: string): Promise<LiveTask[]> {
    const conversationId = await requireConversationId(host, id);
    const graph = await internalHarness(host).taskGraph(context);
    try {
        return Object.values(graph.value.tasks)
            .filter((node) => node.conversationId === conversationId)
            .map((node) => ({
                taskId: String(node.id),
                kind: node.kind,
                state: node.state.status,
                ...(node.blocked === undefined ? {} : { blockedReason: node.blocked }),
            }));
    } finally {
        graph.dispose();
    }
}
