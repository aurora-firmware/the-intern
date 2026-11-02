/**
 * The startup repair of jobs (S-004 REQ-018; ADR-001 decision 4, second bounded exception). A job write and the
 * pi-durable change it goes with are two commits, so a crash between them leaves a job and its conversations out of
 * step. These four rules, applied in this order to each job, and the turn-end check that follows them, are the only
 * recovery the daemon applies to jobs. Each rule that applies writes its `repair` history entry first, so a crash
 * before its change lets the rule apply again at the next start, and each rule is safe to repeat.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import { hasQueuedInput } from "../host/conversation_control.ts";
import { abortJobConversations, continueWithHeld, parkConversation } from "../host/invocation.ts";
import { readConversationMeta } from "../host/seating.ts";
import {
    leadConversationOf,
    leadRefusedJustification,
    leadStartFor,
    startLeadConversation,
} from "../service/job_operations.ts";
import { ServiceError } from "../service/operations.ts";
import { cancelJob, type JobActionDeps, resumeJob } from "./job_actions.ts";
import type { Job } from "./job_store.ts";
import { checkTurnEnd } from "./turn_end_rule.ts";

const DAEMON = { kind: "daemon" } as const;
const PAGE_SIZE = 500;

async function allJobs(ctx: ServiceContext): Promise<Job[]> {
    const jobs: Job[] = [];
    let cursor: string | undefined;
    do {
        const page = await ctx.jobStore.listJobs({ limit: PAGE_SIZE, ...(cursor && { cursor }) });
        jobs.push(...page.jobs);
        cursor = page.cursor;
    } while (cursor !== undefined);
    return jobs;
}

// Input the lead has not taken: queued in its inbox, or held. A held message waits only for a lead parked for reports
// (S-004 REQ-012), so one beside a park for an answer is older than the block.
async function leadHoldsInput(ctx: ServiceContext, leadId: string): Promise<boolean> {
    const meta = await readConversationMeta(ctx.host, leadId);
    if (meta === undefined) return false;
    if (meta.held.length > 0 && meta.parked?.waitingFor !== "answer") return true;
    return hasQueuedInput(ctx.host, leadId);
}

/** Rule 3: a Blocked job whose lead holds input is set In progress, and the lead continues with that input. */
async function applyRule3(deps: JobActionDeps, jobId: string): Promise<void> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status !== "blocked") return;
    const leadId = await leadConversationOf(ctx.host, job.id);
    if (leadId === undefined || !(await leadHoldsInput(ctx, leadId))) return;
    await ctx.jobStore.recordRepair(job.id, {
        rule: 3,
        did: "Set the job In progress: its lead held input it had not taken since the job blocked",
    });
    // The lead takes the input first and the resume follows it, as when the input arrives (S-004 REQ-006).
    await continueWithHeld(ctx.host, leadId);
    await resumeJob(deps, job.id, DAEMON);
}

/** Rule 1: a job that isn't Done and has no lead conversation gets it started, or is cancelled when that is refused. */
async function applyRule1(deps: JobActionDeps, jobId: string): Promise<void> {
    const { ctx, options } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status === "done" || (await leadConversationOf(ctx.host, job.id)) !== undefined) return;
    await ctx.jobStore.recordRepair(job.id, { rule: 1, did: "Started the lead conversation, which the job lacked" });
    try {
        await startLeadConversation(ctx, options.agents, await leadStartFor(ctx, job));
    } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        await cancelJob(deps, job.id, leadRefusedJustification(error), DAEMON);
    }
}

/** Rule 2: a Blocked job whose lead conversation isn't parked gets it parked for an answer. */
async function applyRule2(deps: JobActionDeps, jobId: string): Promise<void> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status !== "blocked") return;
    const leadId = await leadConversationOf(ctx.host, job.id);
    if (leadId === undefined || (await readConversationMeta(ctx.host, leadId))?.parked !== null) return;
    await ctx.jobStore.recordRepair(job.id, { rule: 2, did: "Parked the lead conversation of the Blocked job" });
    await parkConversation(ctx.host, leadId, { waitingFor: "answer", continueOn: "each" });
}

async function hasActiveConversation(ctx: ServiceContext, jobId: string): Promise<boolean> {
    for (const { id } of await ctx.host.listConversations()) {
        const meta = await readConversationMeta(ctx.host, id);
        if (meta?.jobId !== jobId) continue;
        if (meta.parked !== null || meta.awaiting.length > 0) return true;
        if ((await ctx.host.conversationInfo(id))?.busy) return true;
    }
    return false;
}

/** Rule 4: a Done job with conversations still running, parked or awaiting a report gets them aborted. */
async function applyRule4(deps: JobActionDeps, jobId: string): Promise<void> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status !== "done" || !(await hasActiveConversation(ctx, job.id))) return;
    await ctx.jobStore.recordRepair(job.id, { rule: 4, did: "Aborted the conversations of the Done job" });
    await abortJobConversations(ctx.host, job.id);
}

/**
 * Applies the four repair rules to every job, then the turn-end rule (S-004 REQ-008) to each In progress job whose
 * lead is idle and waits for nothing. The turn-end check is that rule applied to saved state, not a fifth repair.
 */
export async function repairJobs(deps: JobActionDeps): Promise<void> {
    const jobs = await allJobs(deps.ctx);
    for (const { id } of jobs) {
        await applyRule3(deps, id);
        await applyRule1(deps, id);
        await applyRule2(deps, id);
        await applyRule4(deps, id);
    }
    if (deps.options.turnEndRule === false) return;
    for (const { id } of jobs) await checkTurnEnd(deps, id);
}
