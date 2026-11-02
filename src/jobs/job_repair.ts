/**
 * The startup repair of jobs (S-004 REQ-018; ADR-001 decision 4, second bounded exception). A job write and the
 * pi-durable change it goes with are two commits, so a crash between them leaves a job and its conversations out of
 * step. These four rules, applied in this order to each job, and the turn-end check that follows them, are the only
 * recovery the daemon applies to jobs. Each rule that applies writes its `repair` history entry first, so a crash
 * before its change lets the rule apply again at the next start, and each rule is safe to repeat.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import { hasInputSince, hasQueuedInput } from "../host/conversation_control.ts";
import { abortJobConversations, continueWithHeld, parkConversation, unparkConversation } from "../host/invocation.ts";
import { readConversationMeta } from "../host/seating.ts";
import { leadRefusedJustification, leadStartFor, startLeadConversation } from "../service/job_operations.ts";
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

/** What one listing of the conversations shows about a job: its lead, and whether any of them runs, parks or awaits. */
type JobConversations = { leadId?: string; isActive: boolean };

// One pass over the conversations for the whole repair, so its cost grows with the conversations and the jobs, not
// with their product. No listener answers and no work resumes while the repair runs (S-002 REQ-002 step 7), so only
// the rules themselves change a conversation, and rule 1 reports the lead it starts.
async function indexConversations(ctx: ServiceContext): Promise<Map<string, JobConversations>> {
    const index = new Map<string, JobConversations>();
    for (const { id, busy } of await ctx.host.listConversations()) {
        const meta = await readConversationMeta(ctx.host, id);
        if (meta === undefined) continue;
        const entry = index.get(meta.jobId) ?? { isActive: false };
        if (meta.isLead) entry.leadId = id;
        if (busy || meta.parked !== null || meta.awaiting.length > 0) entry.isActive = true;
        index.set(meta.jobId, entry);
    }
    return index;
}

// Input the lead has not taken: queued in its inbox, or held. A held message waits only for a lead parked for reports
// (S-004 REQ-012), so one beside a park for an answer is older than the block.
async function leadHoldsInput(ctx: ServiceContext, leadId: string): Promise<boolean> {
    const meta = await readConversationMeta(ctx.host, leadId);
    if (meta === undefined) return false;
    if (meta.held.length > 0 && meta.parked?.waitingFor !== "answer") return true;
    return hasQueuedInput(ctx.host, leadId);
}

// Input the lead took since the job blocked: an input entry after the one the block recorded (ADR-001 decision 4).
// A job blocked before that entry was recorded has none, so the scan does not apply to it.
async function leadTookInput(ctx: ServiceContext, leadId: string, jobId: string): Promise<boolean> {
    const blockedAfterEntry = await ctx.jobStore.blockedAfterEntryOf(jobId);
    return blockedAfterEntry !== null && hasInputSince(ctx.host, leadId, blockedAfterEntry);
}

/** Rule 3: a Blocked job whose lead holds or took input is set In progress, and the lead continues with that input. */
async function applyRule3(deps: JobActionDeps, jobId: string, leadId: string | undefined): Promise<void> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status !== "blocked" || leadId === undefined) return;
    const holds = await leadHoldsInput(ctx, leadId);
    if (!holds && !(await leadTookInput(ctx, leadId, job.id))) return;
    await ctx.jobStore.recordRepair(job.id, {
        rule: 3,
        did: "Set the job In progress: its lead held or had taken input since the job blocked",
    });
    // The lead takes the input first and the resume follows it, as when the input arrives (S-004 REQ-006). Input the
    // lead already took, or input queued for it, leaves nothing to deliver, but a park for the answer that the block
    // made is cleared all the same: the lead continues, and the turn-end rule sees it as waiting for nothing.
    const meta = await readConversationMeta(ctx.host, leadId);
    if (meta?.held.length) await continueWithHeld(ctx.host, leadId);
    else if (meta?.parked) await unparkConversation(ctx.host, leadId);
    await resumeJob(deps, job.id, DAEMON);
}

/**
 * Rule 1: a job that isn't Done and has no lead conversation gets it started, or is cancelled when that is refused.
 * Returns the job's lead conversation after the rule.
 */
async function applyRule1(deps: JobActionDeps, jobId: string, leadId: string | undefined) {
    const { ctx, options } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status === "done" || leadId !== undefined) return leadId;
    await ctx.jobStore.recordRepair(job.id, { rule: 1, did: "Started the lead conversation, which the job lacked" });
    try {
        return (await startLeadConversation(ctx, options.agents, await leadStartFor(ctx, job))).conversationId;
    } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        await cancelJob(deps, job.id, leadRefusedJustification(error), DAEMON);
        return undefined;
    }
}

/** Rule 2: a Blocked job whose lead conversation isn't parked gets it parked for an answer. */
async function applyRule2(deps: JobActionDeps, jobId: string, leadId: string | undefined): Promise<void> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status !== "blocked" || leadId === undefined) return;
    if ((await readConversationMeta(ctx.host, leadId))?.parked !== null) return;
    await ctx.jobStore.recordRepair(job.id, { rule: 2, did: "Parked the lead conversation of the Blocked job" });
    await parkConversation(ctx.host, leadId, { waitingFor: "answer", continueOn: "each" });
}

/** Rule 4: a Done job with conversations still running, parked or awaiting a report gets them aborted. */
async function applyRule4(deps: JobActionDeps, jobId: string, isActive: boolean): Promise<void> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (job.status !== "done" || !isActive) return;
    await ctx.jobStore.recordRepair(job.id, { rule: 4, did: "Aborted the conversations of the Done job" });
    await abortJobConversations(ctx.host, job.id);
}

/**
 * Applies the four repair rules to every job, then the turn-end rule (S-004 REQ-008) to each In progress job whose
 * lead is idle and waits for nothing. The turn-end check is that rule applied to saved state, not a fifth repair.
 * The conversations are listed once, before the rules, so a Done job with nothing active costs no conversation read.
 */
export async function repairJobs(deps: JobActionDeps): Promise<void> {
    const jobs = await allJobs(deps.ctx);
    const index = await indexConversations(deps.ctx);
    const leads = new Map<string, string>();
    for (const { id } of jobs) {
        const known = index.get(id) ?? { isActive: false };
        await applyRule3(deps, id, known.leadId);
        const leadId = await applyRule1(deps, id, known.leadId);
        if (leadId !== undefined) leads.set(id, leadId);
        await applyRule2(deps, id, leadId);
        await applyRule4(deps, id, known.isActive);
    }
    if (deps.options.turnEndRule === false) return;
    for (const { id } of jobs) await checkTurnEnd(deps, id, leads.get(id));
}
