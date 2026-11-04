/**
 * The job actions (S-004 REQ-005 to REQ-007): the one place each action's job write and side effect live. A job write
 * that block, complete or cancel go with is committed first, then the `afterWrite` hook runs, then the pi-durable
 * change is made (ADR-001 decision 4, second bounded exception; S-004 REQ-018). Complete and cancel close every
 * conversation of the job, and the hook runs again after the closed marks, before the aborts.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import type { SubmittedInput } from "../host/conversation_control.ts";
import { abortJobConversations, parkConversation, unparkConversation } from "../host/invocation.ts";
import { readConversationMeta } from "../host/seating.ts";
import { leadConversationOf } from "../service/job_operations.ts";
import type { JobAuthor } from "./job_model.ts";
import { type Job, JobNotFoundError } from "./job_store.ts";
import type { JobsComponentOptions } from "./jobs_component.ts";

/** The request id prefix of the input that `jobs.resume` writes together with the resume. */
export const RESUME_REQUEST_PREFIX = "resume:";

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
    const leadId = await leadConversationOf(ctx.host, job.id);
    // Read before the block write, so input the lead takes after it is after this entry (S-004 REQ-018 rule 3).
    const blockedAfterEntry = leadId === undefined ? null : await ctx.host.readNewestEntryId(leadId);
    const blocked = await ctx.jobStore.applyAction(
        job.id,
        "block",
        {
            blockedReason: reason,
            ...(activeInvocation !== undefined && { activeInvocation }),
            ...(blockedAfterEntry !== null && { blockedAfterEntry }),
        },
        author,
    );
    await options.afterWrite?.("job-blocked", job.id);
    if (leadId === undefined) return blocked;
    await parkConversation(ctx.host, leadId, { waitingFor: "answer", continueOn: "each" });
    // Input that reached the lead between the block and the park has resumed the job and started the lead's run, so
    // the lead must not stay parked.
    if ((await ctx.jobStore.getJob(job.id)).status !== "blocked") await unparkConversation(ctx.host, leadId);
    return blocked;
}

/** Resumes a Blocked job and clears its reason. A job that is not Blocked is returned unchanged. */
export async function resumeJob(deps: JobActionDeps, jobId: string, author: JobAuthor): Promise<Job> {
    const { jobStore } = deps.ctx;
    const job = await jobStore.getJob(jobId);
    if (job.status !== "blocked") return job;
    return jobStore.applyAction(job.id, "resume", {}, author);
}

/**
 * Resumes a Blocked job when input reaches its lead conversation, with the daemon as author. The input is already
 * committed to the lead. A request id starting with `resume:` is the resume that `jobs.resume` writes itself.
 */
export async function resumeAfterLeadInput(deps: JobActionDeps, input: SubmittedInput): Promise<void> {
    if (input.requestId.startsWith(RESUME_REQUEST_PREFIX)) return;
    const { ctx, options } = deps;
    const meta = await readConversationMeta(ctx.host, input.conversationId);
    if (!meta?.isLead || meta.jobId === null) return;
    try {
        const job = await ctx.jobStore.getJob(meta.jobId);
        if (job.status !== "blocked") return;
        await options.afterWrite?.("lead-input", job.id);
        await resumeJob(deps, job.id, { kind: "daemon" });
        // A park that landed after the read above: the input is already in the lead, so it must not stay parked.
        if ((await readConversationMeta(ctx.host, input.conversationId))?.parked) {
            await unparkConversation(ctx.host, input.conversationId);
        }
    } catch (error) {
        if (!(error instanceof JobNotFoundError)) throw error;
    }
}

/** The steps after the Done or Cancelled write: the hook, the closed marks, the hook again and the aborts. */
async function closeAfterFinish(
    deps: JobActionDeps,
    action: "complete" | "cancel",
    jobId: string,
    ownConversationId?: string,
): Promise<void> {
    const { ctx, options } = deps;
    await options.afterWrite?.(action === "complete" ? "job-completed" : "job-cancelled", jobId);
    const own =
        ownConversationId === undefined
            ? undefined
            : {
                  conversationId: ownConversationId,
                  onError: (error: unknown) => logFinishFailure(ctx, jobId, "could not abort a conversation", error),
              };
    await abortJobConversations(ctx.host, jobId, own, () => options.afterWrite?.("conversations-closed", jobId));
}

function logFinishFailure(ctx: ServiceContext, jobId: string, what: string, error: unknown): void {
    ctx.logger.error(what, { jobId, cause: error instanceof Error ? error.message : String(error) });
}

async function finishJob(
    deps: JobActionDeps,
    action: "complete" | "cancel",
    jobId: string,
    justification: string,
    author: JobAuthor,
    ownConversationId?: string,
): Promise<Job> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    const done = await ctx.jobStore.applyAction(job.id, action, { justification }, author);
    if (ownConversationId === undefined) {
        await closeAfterFinish(deps, action, job.id);
        return done;
    }
    // The job is Done, so a later failure must not fail the lead's tool call: it would drop `terminate` and start
    // another model turn. Repair rule 4 finishes what failed at the next start.
    try {
        await closeAfterFinish(deps, action, job.id, ownConversationId);
    } catch (error) {
        logFinishFailure(ctx, job.id, "could not finish closing the job after the Done write", error);
    }
    return done;
}

/**
 * Completes the job with its justification, then closes and aborts every conversation of the job. A lead that
 * completes from its own tool call names its conversation, which is closed and not aborted, and a failure after the
 * Done write is logged and not thrown.
 */
export function completeJob(
    deps: JobActionDeps,
    jobId: string,
    justification: string,
    author: JobAuthor,
    ownConversationId?: string,
) {
    return finishJob(deps, "complete", jobId, justification, author, ownConversationId);
}

/** Cancels the job with its justification, then closes and aborts every conversation of the job. */
export function cancelJob(deps: JobActionDeps, jobId: string, justification: string, author: JobAuthor) {
    return finishJob(deps, "cancel", jobId, justification, author);
}
