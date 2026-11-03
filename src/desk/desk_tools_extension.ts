/**
 * The front desk's job tools (S-004 REQ-021): the tools an agent uses in the front desk to read, list, create and
 * change jobs. The front desk has no job, so each tool names the job it acts on. The extension is built before the host
 * opens, like the job tools, so it takes the host, the job store and the create function as functions that are bound
 * once startup has reached them.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    type Extension,
    type ToolExecutionApi,
    type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { HarnessHost } from "../host/harness_host.ts";
import { readConversationMeta } from "../host/seating.ts";
import { STEER_RECORD_KIND } from "../host/steering.ts";
import { EDITABLE_FIELDS, type JobAuthor, type JobStatus, type Letter } from "../jobs/job_model.ts";
import { JobNotFoundError, JobRefusedError, type JobStore } from "../jobs/job_store.ts";
import type { CreateJobRequest, JobView } from "../service/job_operations.ts";
import { readJob } from "../service/job_record_operations.ts";
import { type Caller, type Catalogue, ServiceError } from "../service/operations.ts";
import { FRONT_DESK_EXTENSION_NAME } from "./desk_model.ts";
import { deskStateTools, jsonResult, textResult } from "./desk_state_tools.ts";
import { deskSteeringTools } from "./desk_steering_tools.ts";

export { FRONT_DESK_EXTENSION_NAME };

export type DeskToolsOptions = {
    host(): HarnessHost;
    jobStore(): JobStore;
    catalogue(): Catalogue;
    createJob(request: CreateJobRequest, caller: Caller): Promise<JobView>;
};

const ENTRY_PAGE_SIZE = 200;
const JOB_FIELD_DESCRIPTION = "The job, by ID or short number such as C-7.";

async function authorOf(
    options: DeskToolsOptions,
    api: ToolExecutionApi,
): Promise<Extract<JobAuthor, { kind: "agent" }>> {
    const conversationId = String(api.conversationId);
    const meta = await readConversationMeta(options.host(), conversationId);
    if (meta === undefined) throw new Error(`Conversation ${conversationId} is not a seated conversation`);
    return { kind: "agent", conversationId, role: meta.seat.role };
}

/** The way in of the latest team member input the front desk took, or `undefined` when it took none. */
async function latestWayIn(host: HarnessHost, conversationId: string): Promise<string | undefined> {
    let wayIn: string | undefined;
    let after: string | undefined;
    do {
        const page = await host.readEntries(conversationId, { limit: ENTRY_PAGE_SIZE, ...(after && { after }) });
        for (const entry of page.entries) {
            if (entry.kind !== STEER_RECORD_KIND) continue;
            const { actor } = entry.data as { actor: { kind: string; wayIn?: string } };
            if (actor.kind === "team_member" && actor.wayIn !== undefined) wayIn = actor.wayIn;
        }
        after = page.next;
    } while (after !== undefined);
    return wayIn;
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

const readJobTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "read_job",
        description: "Read a job with its worklog and its history.",
        parameters: Type.Object({ job: Type.String({ description: JOB_FIELD_DESCRIPTION }) }),
        execute: (args) =>
            refusable("read_job", async () =>
                jsonResult(await readJob({ host: options.host(), jobStore: options.jobStore() }, args.job)),
            ),
    });

const listJobsParameters = Type.Object({
    status: Type.Optional(
        Type.Union([Type.Literal("to_do"), Type.Literal("in_progress"), Type.Literal("blocked"), Type.Literal("done")]),
    ),
    letter: Type.Optional(
        Type.Union(
            ["C", "W", "E", "S", "T", "A"].map((letter) => Type.Literal(letter)),
            {
                description: "The origin letter of the jobs to list.",
            },
        ),
    ),
    limit: Type.Optional(Type.Integer({ description: "The most jobs to return." })),
    cursor: Type.Optional(Type.String({ description: "The cursor of an earlier list, for the next jobs." })),
});

const listJobsTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "list_jobs",
        description: "List jobs, newest last, filtered by status and by origin letter when given.",
        parameters: listJobsParameters,
        execute: (args: Static<typeof listJobsParameters>) =>
            refusable("list_jobs", async () => {
                const filter: { status?: JobStatus; letter?: Letter; limit?: number; cursor?: string } = {};
                if (args.status !== undefined) filter.status = args.status;
                if (args.letter !== undefined) filter.letter = args.letter as Letter;
                if (args.limit !== undefined) filter.limit = args.limit;
                if (args.cursor !== undefined) filter.cursor = args.cursor;
                return jsonResult(await options.jobStore().listJobs(filter));
            }),
    });

const createJobTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "create_job",
        description:
            "Create a job for the request of the team member you are answering. Repeating the same call returns the " +
            "same job.",
        parameters: Type.Object({
            text: Type.String({ description: "The request of the new job." }),
            title: Type.Optional(Type.String({ description: "A title for the new job." })),
            role: Type.Optional(Type.String({ description: "The role of the job's lead, instead of the default." })),
        }),
        async execute(args, api) {
            const conversationId = String(api.conversationId);
            const wayIn = await latestWayIn(options.host(), conversationId);
            if (wayIn === undefined)
                return textResult("create_job was refused: no team member has written to you.", true);
            const request: CreateJobRequest = {
                ...args,
                idempotencyKey: `create_job:${conversationId}:${api.callId}`,
            };
            const caller: Caller = { actor: { kind: "front_desk", conversationId, wayIn } };
            return refusable("create_job", async () => jsonResult(await options.createJob(request, caller)));
        },
    });

const updateJobParameters = Type.Object({
    job: Type.String({ description: JOB_FIELD_DESCRIPTION }),
    title: Type.Optional(Type.String({ description: "The new title." })),
    description: Type.Optional(Type.String({ description: "The new description: goal, needs, plan and analysis." })),
    definitionOfDone: Type.Optional(Type.String({ description: "The new definition of done." })),
});

const updateJobTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "update_job",
        description: "Change the title, the description or the definition of done of a job.",
        parameters: updateJobParameters,
        async execute(args: Static<typeof updateJobParameters>, api) {
            const author = await authorOf(options, api);
            const fields = Object.fromEntries(
                EDITABLE_FIELDS.flatMap((name) => (name in args ? [[name, args[name]]] : [])),
            );
            if (Object.keys(fields).length === 0) {
                return textResult(`update_job was refused: name at least one of ${EDITABLE_FIELDS.join(", ")}.`, true);
            }
            return refusable("update_job", async () =>
                jsonResult(await options.jobStore().updateFields(args.job, fields, author)),
            );
        },
    });

const addWorklogTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "add_worklog",
        description: "Add a note to the worklog of a job.",
        parameters: Type.Object({
            job: Type.String({ description: JOB_FIELD_DESCRIPTION }),
            text: Type.String({ description: "The worklog entry." }),
        }),
        async execute(args, api) {
            const author = await authorOf(options, api);
            return refusable("add_worklog", async () =>
                jsonResult(await options.jobStore().addWorklog(args.job, args.text, author)),
            );
        },
    });

const relateJobsTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "relate_jobs",
        description: "Relate two jobs, or unrelate them.",
        parameters: Type.Object({
            job: Type.String({ description: JOB_FIELD_DESCRIPTION }),
            other: Type.String({ description: "The other job, by ID or short number." }),
            unrelate: Type.Optional(Type.Boolean({ description: "True to remove the link instead of adding it." })),
        }),
        async execute(args, api) {
            const author = await authorOf(options, api);
            const store = options.jobStore();
            return refusable("relate_jobs", async () => {
                const change = args.unrelate === true ? store.unrelate : store.relate;
                const { a, b } = await change.call(store, args.job, args.other, author);
                return textResult(
                    `${a.number} and ${b.number} are ${args.unrelate === true ? "no longer " : ""}related.`,
                );
            });
        },
    });

export function createDeskToolsExtension(options: DeskToolsOptions): Extension {
    return defineExtension({
        name: FRONT_DESK_EXTENSION_NAME,
        tools: [
            readJobTool(options),
            listJobsTool(options),
            createJobTool(options),
            updateJobTool(options),
            addWorklogTool(options),
            relateJobsTool(options),
            ...deskStateTools(options),
            ...deskSteeringTools(options),
        ],
    });
}
