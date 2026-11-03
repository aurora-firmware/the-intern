/**
 * The front desk's steering tools (S-001 AC-022.4 to AC-022.6, AC-023.2): it sends input to a conversation and stops
 * one, as a team member does with `conversations.submit` and `conversations.abort`. A message is placed as an
 * `intern.steer` entry whose actor is the front desk's agent (ADR-004 decisions 2 and 3).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { HostNotFoundError } from "../host/conversation_control.ts";
import { abortWithAwaited } from "../host/invocation.ts";
import { ConversationClosedError } from "../host/job_section.ts";
import { readConversationMeta } from "../host/seating.ts";
import { steerConversation } from "../host/steering.ts";
import { textResult } from "./desk_state_tools.ts";
import type { DeskToolsOptions } from "./desk_tools_extension.ts";
import { readFrontDeskId } from "./front_desk.ts";

const sendParameters = Type.Object({
    conversationId: Type.String({ description: "The conversation to send to." }),
    message: Type.String({ description: "The message to send." }),
    mode: Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
        description:
            "steer arrives after the conversation's current tool calls, followUp after its run ends. A parked " +
            "conversation holds either until it continues; the lead of a Blocked job continues with it and the job " +
            "is In progress again.",
    }),
});

const stopParameters = Type.Object({
    conversationId: Type.String({ description: "The conversation to stop, with the agents it awaits." }),
});

// Aborting the front desk's own conversation would end the run that calls the tool, and no agent can steer it.
async function refuseFrontDesk(options: DeskToolsOptions, tool: string, conversationId: string) {
    if (conversationId !== (await readFrontDeskId(options.host()))) return undefined;
    return textResult(`${tool} was refused: the front desk is not a conversation to steer or stop.`, true);
}

async function deskRole(options: DeskToolsOptions, api: ToolExecutionApi): Promise<string> {
    const deskId = String(api.conversationId);
    const meta = await readConversationMeta(options.host(), deskId);
    if (meta === undefined) throw new Error(`Conversation ${deskId} is not a seated conversation`);
    return meta.seat.role;
}

const sendToConversationTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "send_to_conversation",
        description:
            "Send a message to a conversation of a job, for example a job's lead. A running conversation takes it " +
            "after its current tool calls (steer) or after its run ends (followUp); a parked one holds it, and the " +
            "lead of a Blocked job continues with it.",
        parameters: sendParameters,
        async execute(args, api) {
            const refusal = await refuseFrontDesk(options, "send_to_conversation", args.conversationId);
            if (refusal !== undefined) return refusal;
            const deskId = String(api.conversationId);
            try {
                const { held } = await steerConversation(options.host(), args.conversationId, {
                    content: args.message,
                    mode: args.mode,
                    actor: { kind: "agent", conversationId: deskId, role: await deskRole(options, api) },
                    requestId: `steer:${deskId}:${api.callId}`,
                });
                return textResult(
                    held
                        ? `Conversation ${args.conversationId} is parked and will receive the message when it continues.`
                        : `The message was sent to conversation ${args.conversationId}.`,
                );
            } catch (error) {
                if (error instanceof HostNotFoundError || error instanceof ConversationClosedError) {
                    return textResult(`send_to_conversation was refused: ${error.message}`, true);
                }
                throw error;
            }
        },
    });

const stopConversationTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "stop_conversation",
        description: "Stop a conversation and the agents it awaits, as a team member's abort does.",
        parameters: stopParameters,
        async execute(args) {
            const refusal = await refuseFrontDesk(options, "stop_conversation", args.conversationId);
            if (refusal !== undefined) return refusal;
            try {
                const stopped = await abortWithAwaited(options.host(), args.conversationId);
                return textResult(`Stopped conversations: ${stopped.join(", ")}.`);
            } catch (error) {
                if (error instanceof HostNotFoundError || error instanceof ConversationClosedError) {
                    return textResult(`stop_conversation was refused: ${error.message}`, true);
                }
                throw error;
            }
        },
    });

export function deskSteeringTools(options: DeskToolsOptions) {
    return [sendToConversationTool(options), stopConversationTool(options)];
}
