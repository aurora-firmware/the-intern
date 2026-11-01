/**
 * The coordination extension (S-001 R-6, Component 4): the tools an agent uses to work with other agents. It is built
 * before the host opens, like the admission extension, so it takes the host and the agents runtime as functions that
 * are bound once startup has reached them.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    type CompactionInput,
    CompactionTask,
    defineExtension,
    defineTool,
    type Extension,
    InboxDoc,
    ResetEntry,
    type ToolExecutionApi,
    type ToolExecutionResult,
    type Tx,
} from "@earendil-works/pi-durable";
import type { AgentsRuntime } from "../agents/agents_component.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { createInvokedConversations, InvocationDepthError, type InvocationRequest } from "../host/invocation.ts";
import {
    type ContextMode,
    type ParkedState,
    readConversationMeta,
    type SeatChange,
    seatWrites,
} from "../host/seating.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import type { Seat } from "../roles/role_model.ts";
import { WorkspaceRefusedError } from "../workspaces/workspace_registry.ts";

export const COORDINATION_EXTENSION_NAME = "intern.coordination";

export type CoordinationOptions = {
    host(): HarnessHost;
    runtime(): AgentsRuntime;
};

type HandoffArguments = {
    role: string;
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
    contextMode: ContextMode;
    note?: string;
};

const handoffParameters = Type.Object({
    role: Type.String({ description: "The role of the new agent." }),
    model: Type.Optional(Type.String({ description: "A model for the new agent, instead of the role's." })),
    thinkingLevel: Type.Optional(Type.String({ description: "A thinking level, instead of the role's." })),
    workspace: Type.Optional(Type.String({ description: "A registered workspace, instead of the role's." })),
    contextMode: Type.Union([Type.Literal("full"), Type.Literal("compact"), Type.Literal("clean")], {
        description: "full keeps the context, compact summarizes it guided by the note, clean starts from the note.",
    }),
    note: Type.Optional(Type.String({ description: "The handoff note. Required for compact and clean." })),
});

const textResult = (text: string, isError = false): ToolExecutionResult => ({
    output: [{ type: "text", text }],
    ...(isError && { isError }),
});

const invokedAgentParameters = Type.Object({
    role: Type.String({ description: "The role of the invoked agent." }),
    model: Type.Optional(Type.String({ description: "A model for the invoked agent, instead of the role's." })),
    thinkingLevel: Type.Optional(Type.String({ description: "A thinking level, instead of the role's." })),
    workspace: Type.Optional(Type.String({ description: "A registered workspace, instead of the role's." })),
    contextMode: Type.Union([Type.Literal("full"), Type.Literal("compact"), Type.Literal("clean")], {
        description: "full forks your context, compact forks and summarizes it, clean starts from the job prompt.",
    }),
    jobPrompt: Type.String({ description: "The part of the job the invoked agent does." }),
});

const invokeParameters = Type.Object({
    agents: Type.Array(invokedAgentParameters, { minItems: 1, description: "The agents to invoke, run in parallel." }),
    // biome-ignore lint/suspicious/noThenProperty: `then` is the parameter name the specification gives the tool
    then: Type.Union([Type.Literal("steerable"), Type.Literal("parked")], {
        description: "steerable keeps your run going; parked ends it until the invoked agents report.",
    }),
});

type InvokedAgentArguments = Static<typeof invokedAgentParameters>;

function resolveSeat(runtime: AgentsRuntime, args: HandoffArguments): Seat | string {
    const { role, contextMode, note, ...overrides } = args;
    if (contextMode !== "full" && (note === undefined || note === "")) {
        return `A ${contextMode} handoff needs a note: it is the new agent's guide to the work.`;
    }
    try {
        return runtime.catalog.seatFor(role, overrides);
    } catch (error) {
        if (error instanceof RoleRefusedError || error instanceof WorkspaceRefusedError) return error.message;
        throw error;
    }
}

// The note becomes the only input of the new context. The tool is running, so the conversation is busy: the reset and
// the input queue in the inbox and land together at the boundary after the tool round, which starts the next run
// without the conversation ever being idle.
async function queueCleanContext(tx: Tx, conversationId: ToolExecutionApi["conversationId"], note: string) {
    const items = (await tx.doc(InboxDoc, conversationId)).items;
    const reset = await tx.createSubmission({ conversationId, type: "write", status: "queued" });
    items.push({ id: reset.id, mode: "write", entry: { kind: ResetEntry.kind, head: "self" } } as never);
    const input = await tx.createSubmission({ conversationId, type: "input", status: "queued" });
    items.push({ id: input.id, mode: "followUp", content: note } as never);
}

async function compactWithNote(api: ToolExecutionApi, change: SeatChange, context: never): Promise<string | undefined> {
    const taskId = await api.commit(async (tx) => {
        await seatWrites(tx, String(api.conversationId), change);
        const input: CompactionInput = {
            reason: "manual",
            ...(change.note !== undefined && { instructions: change.note }),
        };
        return tx.createTask(CompactionTask, input, {
            ownership: { kind: "task", taskId: api.taskId },
            abandonOnRestart: true,
        });
    }, context);
    const settled = await api.waitForTask(taskId, context);
    const { outcome } = settled.state;
    return outcome.status === "completed" ? undefined : `the compaction did not finish (${outcome.status})`;
}

const handoffTool = (options: CoordinationOptions) =>
    defineTool({
        name: "handoff",
        description:
            "Hand this conversation to a new agent of another role. Your own work ends here. The new agent starts " +
            "working at once in the same conversation.",
        parameters: handoffParameters,
        async execute(args, api, context) {
            const seat = resolveSeat(options.runtime(), args);
            if (typeof seat === "string") return textResult(`The handoff was refused: ${seat}`, true);
            const conversationId = String(api.conversationId);
            const meta = await readConversationMeta(options.host(), conversationId);
            if (meta === undefined) throw new Error(`Conversation ${conversationId} is not a seated conversation`);
            const { contextMode, note } = args;
            const actor = { kind: "agent", conversationId, role: meta.seat.role } as const;
            const change: SeatChange = { seat, actor, contextMode, ...(note !== undefined && { note }) };
            if (contextMode === "compact") {
                const failure = await compactWithNote(api, change, context as never);
                if (failure !== undefined) {
                    return textResult(`The seat is now ${seat.role}, but ${failure}.`, true);
                }
            } else {
                await api.commit(async (tx) => {
                    await seatWrites(tx, conversationId, change);
                    if (contextMode === "clean") await queueCleanContext(tx, api.conversationId, note as string);
                }, context);
            }
            return textResult(`This conversation is now handled by a new ${seat.role} agent.`);
        },
    });

// The park continues the invoking conversation on each report; "all" exists in the host for tests (S-001 R-8a).
const PARK_ON_EACH_REPORT: ParkedState = { waitingFor: "reports", continueOn: "each" };

function resolveInvocationSeats(runtime: AgentsRuntime, agents: InvokedAgentArguments[]): InvocationRequest[] | string {
    const requests: InvocationRequest[] = [];
    for (const { role, contextMode, jobPrompt, ...overrides } of agents) {
        try {
            requests.push({ seat: runtime.catalog.seatFor(role, overrides), contextMode, jobPrompt });
        } catch (error) {
            if (error instanceof RoleRefusedError || error instanceof WorkspaceRefusedError) return error.message;
            throw error;
        }
    }
    return requests;
}

// In pi-durable 1.4.0 `terminate` ends the run only when every call of the round asks for it, so the round of a parked
// invoke is read from the assistant message that holds the call.
async function countCallsOfRound(api: ToolExecutionApi, context: never): Promise<number> {
    const page = await api.commit((tx) => tx.scanEntries({ conversationId: api.conversationId }, 20), context);
    const assistant = page.items.find((entry) => entry.kind === AssistantEntry.kind);
    const blocks = (assistant?.model ?? []).flatMap((message) => (message.role === "assistant" ? message.content : []));
    return blocks.filter((block) => block.type === "toolCall").length;
}

const invokeTool = (options: CoordinationOptions) =>
    defineTool({
        name: "invoke",
        description:
            "Invoke one or more agents for parts of your job. They run in parallel, each in its own conversation of " +
            "this job. With steerable you keep working and can steer them; with parked your run ends and you continue " +
            "when they report. A parked invoke must be the only tool call of its turn.",
        parameters: invokeParameters,
        async execute(args, api, context) {
            if (args.then === "parked" && (await countCallsOfRound(api, context as never)) > 1) {
                return textResult(
                    "The invocation was refused: a parked invoke must be the only tool call of its turn. Nothing was created.",
                    true,
                );
            }
            const requests = resolveInvocationSeats(options.runtime(), args.agents);
            if (typeof requests === "string") return textResult(`The invocation was refused: ${requests}`, true);
            const invokingId = String(api.conversationId);
            const meta = await readConversationMeta(options.host(), invokingId);
            if (meta === undefined) throw new Error(`Conversation ${invokingId} is not a seated conversation`);
            const isParked = args.then === "parked";
            try {
                const ids = await createInvokedConversations(options.host(), {
                    invokingId,
                    callId: api.callId,
                    agents: requests,
                    actor: { kind: "agent", conversationId: invokingId, role: meta.seat.role },
                    ...(isParked && { parked: PARK_ON_EACH_REPORT }),
                });
                const result = textResult(`Invoked conversations: ${ids.join(", ")}.`);
                return isParked ? { ...result, control: { terminate: true } } : result;
            } catch (error) {
                if (error instanceof InvocationDepthError) {
                    return textResult(`The invocation was refused: ${error.message} Nothing was created.`, true);
                }
                throw error;
            }
        },
    });

export function createCoordinationExtension(options: CoordinationOptions): Extension {
    return defineExtension({ name: COORDINATION_EXTENSION_NAME, tools: [handoffTool(options), invokeTool(options)] });
}
