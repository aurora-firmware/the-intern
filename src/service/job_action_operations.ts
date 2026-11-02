/**
 * The operations that act on a job (S-004 REQ-005 to REQ-007): resume a Blocked job, and complete or cancel one. There
 * is no block operation for team members. A refusal of the job store is a service refusal of the same code.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import { steerConversation } from "../host/steering.ts";
import { cancelJob, completeJob, resumeJob } from "../jobs/job_actions.ts";
import { blockResumeCount, type JobAuthor, resumeRequestId } from "../jobs/job_model.ts";
import type { Job } from "../jobs/job_store.ts";
import type { JobsComponentOptions } from "../jobs/jobs_component.ts";
import { leadConversationOf } from "./job_operations.ts";
import { allEntries, asRecord, authorOf, refusing, requireString, STORE_PAGE_SIZE } from "./job_record_operations.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

/** What the lead receives when a team member resumes the job without text. */
export const RESUMED_NOTE = "A team member resumed the job.";

type ResumeInput = { job: string; text?: string };
type FinishInput = { job: string; justification: string };

// The steer's actor is the author, who is a team member or an agent: authorOf refuses a job source.
function actorOfAuthor(author: JobAuthor) {
    if (author.kind === "team_member") return { kind: "team_member", wayIn: author.wayIn } as const;
    if (author.kind === "agent") return author;
    throw new Error("A daemon author does not resume a job");
}

function parseResume(raw: unknown): ResumeInput {
    const record = asRecord(raw);
    const input: ResumeInput = { job: requireString(record, "job") };
    if (record.text !== undefined) input.text = requireString(record, "text");
    return input;
}

function parseFinish(raw: unknown): FinishInput {
    const record = asRecord(raw);
    return { job: requireString(record, "job"), justification: requireString(record, "justification") };
}

export function jobActionOperations(options: JobsComponentOptions) {
    const resume = defineOperation<ServiceContext, ResumeInput, Job>({
        name: "jobs.resume",
        kind: "control",
        parse: parseResume,
        async run(ctx, input, caller) {
            const author = await authorOf(caller, ctx.host);
            const job = await refusing(ctx.jobStore.getJob(input.job));
            if (job.status !== "blocked") {
                throw new ServiceError("conflict", `Job ${job.number} is not Blocked, so it cannot resume`);
            }
            const leadId = await leadConversationOf(ctx.host, job.id);
            if (leadId !== undefined) {
                const history = await allEntries((cursor) =>
                    ctx.jobStore.listHistory(job.id, { limit: STORE_PAGE_SIZE, ...(cursor && { cursor }) }),
                );
                // The text reaches the parked lead before the job is written, so a crash in between leaves a
                // Blocked job whose lead has the answer, which the recovery of rule 3 resumes.
                await steerConversation(ctx.host, leadId, {
                    content: input.text ?? RESUMED_NOTE,
                    mode: "followUp",
                    actor: actorOfAuthor(author),
                    requestId: resumeRequestId(job.id, blockResumeCount(history)),
                });
            }
            return refusing(resumeJob({ ctx, options }, job.id, author));
        },
    });
    const finish = (name: "jobs.complete" | "jobs.cancel", act: typeof completeJob) =>
        defineOperation<ServiceContext, FinishInput, Job>({
            name,
            kind: "control",
            parse: parseFinish,
            async run(ctx, input, caller) {
                const author = await authorOf(caller, ctx.host);
                return refusing(act({ ctx, options }, input.job, input.justification, author));
            },
        });
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [
        resume,
        finish("jobs.complete", completeJob),
        finish("jobs.cancel", cancelJob),
    ];
    return operations;
}
