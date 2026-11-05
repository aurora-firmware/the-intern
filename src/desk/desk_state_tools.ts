/**
 * The front desk's state tools (S-001 AC-022.1): it reads a conversation, its entries and invocations, the daemon
 * status and usage. Each tool calls the operation of the same data through the catalogue as the front desk, so it
 * returns exactly what the operation returns.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { ServiceError } from "../service/operations.ts";
import type { DeskToolsOptions } from "./desk_tools_extension.ts";

export const textResult = (text: string, isError = false): ToolExecutionResult => ({
    output: [{ type: "text", text }],
    ...(isError && { isError }),
});

export const jsonResult = (value: unknown): ToolExecutionResult => textResult(JSON.stringify(value, null, 2));

const CONVERSATION_FIELD = Type.String({ description: "The conversation's ID." });

const entriesParameters = Type.Object({
    conversationId: CONVERSATION_FIELD,
    limit: Type.Optional(Type.Integer({ description: "The most entries to return." })),
    after: Type.Optional(
        Type.String({ description: "The `next` cursor of an earlier read, for the entries after it." }),
    ),
});

const usageParameters = Type.Object({
    conversationId: Type.Optional(
        Type.String({ description: "The conversation to report usage of; omit it for the total." }),
    ),
});

type ReadSpec = {
    tool: string;
    operation: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
};

const READS: readonly ReadSpec[] = [
    {
        tool: "read_conversation",
        operation: "conversations.get",
        description: "Read a conversation's status, seat and job.",
        parameters: Type.Object({ conversationId: CONVERSATION_FIELD }),
    },
    {
        tool: "read_entries",
        operation: "conversations.entries",
        description: "Read a page of a conversation's entries.",
        parameters: entriesParameters,
    },
    {
        tool: "read_invocations",
        operation: "conversations.invocations",
        description: "Read the tree of conversations a conversation invoked.",
        parameters: Type.Object({ conversationId: CONVERSATION_FIELD }),
    },
    {
        tool: "read_status",
        operation: "daemon.status",
        description: "Read the daemon's status: phase, versions, directories and worker threads.",
        parameters: Type.Object({}),
    },
    {
        tool: "read_usage",
        operation: "usage.get",
        description: "Read the token usage and cost of a conversation, or the total.",
        parameters: usageParameters,
    },
];

const readTool = (options: DeskToolsOptions, spec: ReadSpec) =>
    defineTool({
        name: spec.tool,
        description: spec.description,
        parameters: spec.parameters,
        async execute(args: Static<typeof spec.parameters>, api) {
            const caller = { actor: { kind: "agent" as const, conversationId: String(api.conversationId) } };
            try {
                return jsonResult(await options.catalogue().invoke(spec.operation, args, caller));
            } catch (error) {
                // A refused read is an error result for the agent and its run goes on.
                if (error instanceof ServiceError)
                    return textResult(`${spec.tool} was refused: ${error.message}`, true);
                throw error;
            }
        },
    });

export function deskStateTools(options: DeskToolsOptions) {
    return READS.map((spec) => readTool(options, spec));
}
