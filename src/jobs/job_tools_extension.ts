/**
 * The job tools extension (S-004 Interfaces, job tools): the tools an agent uses to read and change the job of its own
 * conversation, to create a follow-up job and to relate two jobs. It is built before the host opens, like the
 * coordination extension, so it takes the host, the job store, the create function and the job actions as functions
 * that are bound once startup has reached them.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    type Extension,
    LiveDoc,
    type ToolExecutionApi,
    type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { countCallsOfRound } from "../coordination/coordination_extension.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { ConversationClosedError, isConversationClosed } from "../host/job_section.ts";
import { readConversationMeta } from "../host/seating.ts";
import type { CreateJobRequest, JobView } from "../service/job_operations.ts";
import { readJob, refuseFrontDesk } from "../service/job_record_operations.ts";
import { type Caller, ServiceError } from "../service/operations.ts";
import { blockJob, completeJob, type JobActionDeps } from "./job_actions.ts";
import { EDITABLE_FIELDS, type JobAuthor } from "./job_model.ts";
import { JobNotFoundError, JobRefusedError, type JobStore } from "./job_store.ts";

export const JOB_TOOLS_EXTENSION_NAME = "intern.jobs";

export type JobToolsOptions = {
    host(): HarnessHost;
    jobStore(): JobStore;
    createJob(request: CreateJobRequest, caller: Caller): Promise<JobView>;
    actions(): JobActionDeps;
};

/** The job of a tool's conversation and the author its writes carry. */
type ToolSeat = {
    jobId: string;
    conversationId: string;
    isLead: boolean;
    author: Extract<JobAuthor, { kind: "agent" }>;
};

const textResult = (text: string, isError = false): ToolExecutionResult => ({
    output: [{ type: "text", text }],
    ...(isError && { isError }),
});

const jsonResult = (value: unknown): ToolExecutionResult => textResult(JSON.stringify(value, null, 2));

// A conversation with no job has nothing for a job tool to act on (S-001 REQ-021).
class NoJobError extends Error {
    constructor(conversationId: string) {
        super(`Conversation ${conversationId} has no job.`);
        this.name = "NoJobError";
    }
}

async function seatOf(options: JobToolsOptions, api: ToolExecutionApi): Promise<ToolSeat> {
    const conversationId = String(api.conversationId);
    const meta = await readConversationMeta(options.host(), conversationId);
    if (meta === undefined) throw new Error(`Conversation ${conversationId} is not a seated conversation`);
    if (meta.jobId === null) throw new NoJobError(conversationId);
    return {
        jobId: meta.jobId,
        conversationId,
        isLead: meta.isLead,
        author: { kind: "agent", conversationId, role: meta.seat.role },
    };
}

// A refused call is an error result for the agent and its run goes on; anything else is a real failure.
async function refusable(tool: string, action: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof JobRefusedError || error instanceof JobNotFoundError || error instanceof ServiceError) {
            return textResult(`${tool} was refused: ${error.message}`, true);
        }
        throw error;
    }
}

const readJobTool = (options: JobToolsOptions) =>
    defineTool({
        name: "read_job",
        description: "Read the job of this conversation with its worklog and its history.",
        parameters: Type.Object({}),
        async execute(_args, api) {
            const { jobId } = await seatOf(options, api);
            return refusable("read_job", async () => jsonResult(await readJob(options.actions().ctx, jobId)));
        },
    });

const updateJobParameters = Type.Object({
    title: Type.Optional(Type.String({ description: "The new title." })),
    description: Type.Optional(Type.String({ description: "The new description: goal, needs, plan and analysis." })),
    definitionOfDone: Type.Optional(Type.String({ description: "The new definition of done." })),
});

const updateJobTool = (options: JobToolsOptions) =>
    defineTool({
        name: "update_job",
        description: "Change the title, the description or the definition of done of the job of this conversation.",
        parameters: updateJobParameters,
        async execute(args: Static<typeof updateJobParameters>, api) {
            const { jobId, author } = await seatOf(options, api);
            const fields = Object.fromEntries(
                EDITABLE_FIELDS.flatMap((name) => (name in args ? [[name, args[name]]] : [])),
            );
            if (Object.keys(fields).length === 0) {
                return textResult(`update_job was refused: name at least one of ${EDITABLE_FIELDS.join(", ")}.`, true);
            }
            return refusable("update_job", async () =>
                jsonResult(await options.jobStore().updateFields(jobId, fields, author)),
            );
        },
    });

const addWorklogTool = (options: JobToolsOptions) =>
    defineTool({
        name: "add_worklog",
        description: "Add a note to the worklog of the job of this conversation: what you tried, did or left.",
        parameters: Type.Object({ text: Type.String({ description: "The worklog entry." }) }),
        async execute(args, api) {
            const { jobId, author } = await seatOf(options, api);
            return refusable("add_worklog", async () =>
                jsonResult(await options.jobStore().addWorklog(jobId, args.text, author)),
            );
        },
    });

const createJobTool = (options: JobToolsOptions) =>
    defineTool({
        name: "create_job",
        description:
            "Create a follow-up job. Set related to true to relate it to the job of this conversation; without it " +
            "the two jobs are not related. Repeating the same call returns the same job.",
        parameters: Type.Object({
            text: Type.String({ description: "The request of the new job." }),
            title: Type.Optional(Type.String({ description: "A title for the new job." })),
            role: Type.Optional(
                Type.String({ description: "The role of the new job's lead, instead of the default." }),
            ),
            related: Type.Optional(
                Type.Boolean({ description: "True to relate the new job to the job of this conversation." }),
            ),
        }),
        async execute(args, api) {
            const { conversationId } = await seatOf(options, api);
            const request: CreateJobRequest = {
                ...args,
                idempotencyKey: `create_job:${conversationId}:${api.callId}`,
            };
            const caller: Caller = { actor: { kind: "agent", conversationId } };
            return refusable("create_job", async () => jsonResult(await options.createJob(request, caller)));
        },
    });

const relateJobsTool = (options: JobToolsOptions) =>
    defineTool({
        name: "relate_jobs",
        description: "Relate the job of this conversation and another job, or unrelate them.",
        parameters: Type.Object({
            job: Type.String({ description: "The other job, by ID or short number such as E-14." }),
            unrelate: Type.Optional(Type.Boolean({ description: "True to remove the link instead of adding it." })),
        }),
        async execute(args, api) {
            const { jobId, author } = await seatOf(options, api);
            const store = options.jobStore();
            return refusable("relate_jobs", async () => {
                await refuseFrontDesk(options.host(), args.job);
                const change = args.unrelate === true ? store.unrelate : store.relate;
                const { a, b } = await change.call(store, jobId, args.job, author);
                return textResult(
                    `${a.number} and ${b.number} are ${args.unrelate === true ? "no longer " : ""}related.`,
                );
            });
        },
    });

// Only a job's lead blocks or completes it (S-004 REQ-013); a refused specialist's run goes on.
const leadOnly = (tool: string, verb: string) =>
    textResult(`${tool} was refused: only the job's lead can ${verb} the job.`, true);

const blockJobTool = (options: JobToolsOptions) =>
    defineTool({
        name: "block_job",
        description:
            "Block the job of this conversation with the reason you need an answer, and end your run until one " +
            "arrives. Only the job's lead can use it, and it must be the only tool call of its turn. It is refused " +
            "while an agent you invoked still runs.",
        parameters: Type.Object({ reason: Type.String({ description: "What you need answered, and why." }) }),
        async execute(args, api, context) {
            const { jobId, isLead, author } = await seatOf(options, api);
            if (!isLead) return leadOnly("block_job", "block");
            if ((await countCallsOfRound(api, context as never)) > 1) {
                return textResult("block_job was refused: it must be the only tool call of its turn.", true);
            }
            const result = await refusable("block_job", async () => {
                await blockJob(options.actions(), jobId, args.reason, author);
                return textResult(`The job is blocked: ${args.reason}`);
            });
            return result.isError === true ? result : { ...result, control: { terminate: true } };
        },
    });

const completeJobTool = (options: JobToolsOptions) =>
    defineTool({
        name: "complete_job",
        description:
            "Complete the job of this conversation, with the justification that its definition of done is met. " +
            "Only the job's lead can use it, the job needs a definition of done, and it must be the only tool call of " +
            "its turn. Your run ends at this call.",
        parameters: Type.Object({
            justification: Type.String({ description: "Why the definition of done is met." }),
        }),
        async execute(args, api, context) {
            const { jobId, conversationId, isLead, author } = await seatOf(options, api);
            if (!isLead) return leadOnly("complete_job", "complete");
            // pi-durable ends a run only when every call of the model turn asks, so the model turn is read from the
            // live state, not from the newest entries, which `countCallsOfRound` scans only in part.
            const live = await api.snapshot(LiveDoc, api.conversationId, context as never);
            if (live?.tools?.length !== 1) {
                return textResult("complete_job was refused: it must be the only tool call of its turn.", true);
            }
            const result = await refusable("complete_job", async () => {
                const done = await completeJob(options.actions(), jobId, args.justification, author, conversationId);
                return textResult(`${done.number} is Done.`);
            });
            return result.isError === true ? result : { ...result, control: { terminate: true } };
        },
    });

// A job tool called in a conversation with no job is an error result for the agent and its run goes on.
function refusingWithoutJob<T extends { name: string; execute: (...args: never[]) => Promise<ToolExecutionResult> }>(
    tool: T,
): T {
    const execute = async (...args: never[]): Promise<ToolExecutionResult> => {
        try {
            return await tool.execute(...args);
        } catch (error) {
            if (error instanceof NoJobError) return textResult(`${tool.name} was refused: ${error.message}`, true);
            throw error;
        }
    };
    return { ...tool, execute };
}

// A job tool called from a closed conversation (S-001 REQ-026) is an error result before it acts, and changes no job.
function refusingWhenClosed(options: JobToolsOptions) {
    return <T extends { name: string; execute: (...args: never[]) => Promise<ToolExecutionResult> }>(tool: T): T => {
        const execute = async (...args: never[]): Promise<ToolExecutionResult> => {
            const conversationId = String((args[1] as ToolExecutionApi).conversationId);
            if (await isConversationClosed(options.host(), conversationId)) {
                const { message } = new ConversationClosedError(conversationId);
                return textResult(`${tool.name} was refused: ${message}`, true);
            }
            return tool.execute(...args);
        };
        return { ...tool, execute };
    };
}

export function createJobToolsExtension(options: JobToolsOptions): Extension {
    return defineExtension({
        name: JOB_TOOLS_EXTENSION_NAME,
        tools: [
            readJobTool(options),
            updateJobTool(options),
            addWorklogTool(options),
            createJobTool(options),
            relateJobsTool(options),
            blockJobTool(options),
            completeJobTool(options),
        ]
            .map(refusingWithoutJob)
            .map(refusingWhenClosed(options)),
    });
}
