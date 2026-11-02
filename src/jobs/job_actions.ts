/**
 * The job actions (S-004 REQ-005 to REQ-007): the one place each action's job write and side effect live. A job write
 * that block, complete or cancel go with is committed first, then the `afterWrite` hook runs, then the pi-durable
 * change is made (ADR-001 decision 4, second bounded exception; S-004 REQ-018).
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import { abortJobConversations, parkConversation } from "../host/invocation.ts";
import { readConversationMeta } from "../host/seating.ts";
import { leadConversationOf } from "../service/job_operations.ts";
import type { JobAuthor } from "./job_model.ts";
import type { Job } from "./job_store.ts";
import type { JobsComponentOptions } from "./jobs_component.ts";

export type JobActionDeps = { ctx: ServiceContext; options: JobsComponentOptions };

/** Starts a To do job. A job that is In progress is returned unchanged, so repeating the start is safe. */
export async function startJob(deps: JobActionDeps, jobId: string): Promise<Job> {
    const { jobStore } = deps.ctx;
    const job = await jobStore.getJob(jobId);
    if (job.status === "in_progress") return job;
    return jobStore.applyAction(job.id, "start", {}, { kind: "daemon" });
}

// The invocation that stops a block: a conversation the lead awaits, else an invoked conversation of the job that runs.
async function activeInvocationOf(ctx: ServiceContext, jobId: string): Promise<string | undefined> {
    const leadId = await leadConversationOf(ctx.host, jobId);
    const awaited = leadId === undefined ? undefined : (await readConversationMeta(ctx.host, leadId))?.awaiting[0];
    if (awaited !== undefined) return awaited;
    for (const { id } of await ctx.host.listConversations()) {
        const meta = await readConversationMeta(ctx.host, id);
        if (meta?.jobId !== jobId || meta.isLead) continue;
        if ((await ctx.host.conversationInfo(id))?.busy) return id;
    }
    return undefined;
}

/** Blocks the job with the reason, then parks its lead conversation to wait for an answer. */
export async function blockJob(deps: JobActionDeps, jobId: string, reason: string, author: JobAuthor): Promise<Job> {
    const { ctx, options } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    const activeInvocation = await activeInvocationOf(ctx, job.id);
    const blocked = await ctx.jobStore.applyAction(
        job.id,
        "block",
        { blockedReason: reason, ...(activeInvocation !== undefined && { activeInvocation }) },
        author,
    );
    await options.afterWrite?.("job-blocked", job.id);
    const leadId = await leadConversationOf(ctx.host, job.id);
    if (leadId !== undefined) await parkConversation(ctx.host, leadId, { waitingFor: "answer", continueOn: "each" });
    return blocked;
}

/** Resumes a Blocked job and clears its reason. A job that is not Blocked is returned unchanged. */
export async function resumeJob(deps: JobActionDeps, jobId: string, author: JobAuthor): Promise<Job> {
    const { jobStore } = deps.ctx;
    const job = await jobStore.getJob(jobId);
    if (job.status !== "blocked") return job;
    return jobStore.applyAction(job.id, "resume", {}, author);
}

async function finishJob(
    deps: JobActionDeps,
    action: "complete" | "cancel",
    jobId: string,
    justification: string,
    author: JobAuthor,
): Promise<Job> {
    const { ctx, options } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    const done = await ctx.jobStore.applyAction(job.id, action, { justification }, author);
    await options.afterWrite?.(action === "complete" ? "job-completed" : "job-cancelled", job.id);
    await abortJobConversations(ctx.host, job.id);
    return done;
}

/** Completes the job with its justification, then aborts every conversation of the job. */
export function completeJob(deps: JobActionDeps, jobId: string, justification: string, author: JobAuthor) {
    return finishJob(deps, "complete", jobId, justification, author);
}

/** Cancels the job with its justification, then aborts every conversation of the job. */
export function cancelJob(deps: JobActionDeps, jobId: string, justification: string, author: JobAuthor) {
    return finishJob(deps, "cancel", jobId, justification, author);
}
