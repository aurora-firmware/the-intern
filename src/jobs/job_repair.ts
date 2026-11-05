/**
 * The startup repair of jobs (S-004 REQ-018; ADR-001 decision 4, second bounded exception). A job write and the
 * pi-durable change it goes with are two commits, so a crash between them leaves a job and its conversations out of
 * step. These four rules, applied in this order to each job, and the turn-end check that follows them, are the only
 * recovery the daemon applies to jobs. Each rule that applies writes its `repair` history entry first, so a crash
 * before its change lets the rule apply again at the next start, and each rule is safe to repeat.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import { hasInputSince, hasQueuedUserInput, hasSubmissionWithRequestId } from "../host/conversation_control.ts";
import { continueWithHeld, parkConversation, unparkConversation } from "../host/invocation.ts";
import { markJobConversationsForAbort } from "../host/repair_abort.ts";
import { readConversationMeta } from "../host/seating.ts";
import {
    leadRefusedJustification,
    leadStartFor,
    leadStartRequestId,
    startLeadConversation,
} from "../service/job_operations.ts";
import { ServiceError } from "../service/operations.ts";
import { type JobActionDeps, resumeJob } from "./job_actions.ts";
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

/**
 * What one listing of the conversations shows about a job: its lead, whether one of them isn't closed or runs, parks
 * or awaits, and the closed, idle ones, whose queued input only rule 4 reads, and only for a Done job.
 */
type JobConversations = { leadId?: string; isUnsettled: boolean; idleClosedIds: string[] };

// One pass over the conversations for the whole repair, so its cost grows with the conversations and the jobs, not
// with their product. No listener answers while the repair runs (S-002 REQ-002 step 7), so only the rules themselves
// change a conversation, and rule 1 reports the lead it starts. Rule 4 never turns scheduling on, so no run resumes.
async function indexConversations(ctx: ServiceContext): Promise<Map<string, JobConversations>> {
    const index = new Map<string, JobConversations>();
    for (const { id, busy } of await ctx.host.listConversations()) {
        const meta = await readConversationMeta(ctx.host, id);
        if (meta === undefined || meta.jobId === null) continue;
        const entry = index.get(meta.jobId) ?? { isUnsettled: false, idleClosedIds: [] };
        if (meta.isLead) entry.leadId = id;
        if (meta.closed !== true || busy || meta.parked !== null || meta.awaiting.length > 0) entry.isUnsettled = true;
        else entry.idleClosedIds.push(id);
        index.set(meta.jobId, entry);
    }
    return index;
}

// Input the lead has not taken: queued in its inbox (a queued write is not input), or held. A held message waits only
// for a lead parked for reports (S-004 REQ-012), so one beside a park for an answer is older than the block.
async function leadHoldsInput(ctx: ServiceContext, leadId: string): Promise<boolean> {
    const meta = await readConversationMeta(ctx.host, leadId);
    if (meta === undefined) return false;
    if (meta.held.length > 0 && meta.parked?.waitingFor !== "answer") return true;
    return hasQueuedUserInput(ctx.host, leadId);
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
 * Whether rule 1 applies: the job isn't Done and has no lead conversation, or it is To do and its lead conversation
 * holds no submission with the first input's request id (a start cut short between the two commits). Only a To do job
 * with a known lead costs the submission read.
 */
async function needsLeadStart(ctx: ServiceContext, job: Job, leadId: string | undefined): Promise<boolean> {
    if (job.status === "done") return false;
    if (leadId === undefined) return true;
    if (job.status !== "to_do") return false;
    return !(await hasSubmissionWithRequestId(ctx.host, leadId, leadStartRequestId(job.id)));
}

/**
 * Rule 1: a job that isn't Done and has no lead conversation gets it started, and a To do job whose lead never
 * received its first input gets that input submitted. A refused start cancels the job, and the aborts of its
 * conversations are marks, as in rule 4, because the normal cancel's abort turns scheduling on.
 * Returns the job's lead conversation after the rule, and the conversations it marked for abort.
 */
async function applyRule1(
    deps: JobActionDeps,
    jobId: string,
    leadId: string | undefined,
): Promise<{ leadId: string | undefined; marked: string[] }> {
    const { ctx, options } = deps;
    const job = await ctx.jobStore.getJob(jobId);
    if (!(await needsLeadStart(ctx, job, leadId))) return { leadId, marked: [] };
    const did =
        leadId === undefined
            ? "Started the lead conversation, which the job lacked"
            : "Submitted the first input of the lead conversation, whose start was cut short";
    await ctx.jobStore.recordRepair(job.id, { rule: 1, did });
    try {
        const start = await leadStartFor(ctx, job);
        const started = await startLeadConversation(ctx, options.agents, start, options.afterWrite);
        return { leadId: started.conversationId, marked: [] };
    } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        const justification = leadRefusedJustification(error);
        await ctx.jobStore.applyAction(job.id, "cancel", { justification }, DAEMON);
        return { leadId: undefined, marked: await markJobConversationsForAbort(ctx.host, job.id) };
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

// Whether a Done job's conversations need rule 4: one isn't closed, runs, parks or awaits, or has queued input. A
// queued write is not input: a closed conversation runs nothing, so it is never placed and needs no repair.
async function needsClosing(ctx: ServiceContext, known: JobConversations): Promise<boolean> {
    if (known.isUnsettled) return true;
    for (const id of known.idleClosedIds) if (await hasQueuedUserInput(ctx.host, id)) return true;
    return false;
}

/**
 * Rule 4: a Done job with a conversation that isn't closed, or that is closed but still runs or has queued input,
 * gets its conversations closed and aborted: the closed marks are committed before the aborts. The aborts are marks
 * on the work, because ending it takes scheduling, which stays off until the daemon resumes the host after the repair.
 * Returns the conversations it marked, which the caller waits for once the host has resumed.
 * `listed` is the job as listed before the rules: a job that rule 1 cancels was not Done then, and that cancel
 * already closed its conversations, so the listing taken before it does not apply to it.
 * A closed conversation with a compaction still running is busy, because every live task counts, so it is unsettled
 * and this rule fires for it too; the abort then stops the compaction, which no closed mark stops by itself.
 */
async function applyRule4(deps: JobActionDeps, listed: Job, known: JobConversations): Promise<string[]> {
    const { ctx } = deps;
    if (listed.status !== "done" || !(await needsClosing(ctx, known))) return [];
    await ctx.jobStore.recordRepair(listed.id, {
        rule: 4,
        did: "Closed and aborted the conversations of the Done job",
    });
    return markJobConversationsForAbort(ctx.host, listed.id);
}

/**
 * Applies the four repair rules to every job, then the turn-end rule (S-004 REQ-008) to each In progress job whose
 * lead is idle and waits for nothing. The turn-end check is that rule applied to saved state, not a fifth repair.
 * The conversations are listed once, before the rules, so a Done job whose conversations are all closed and idle
 * costs one queued-input read per conversation and no other conversation read.
 * Returns the conversations rules 1 and 4 marked for abort, which end once the host resumes.
 */
export async function repairJobs(deps: JobActionDeps): Promise<string[]> {
    const jobs = await allJobs(deps.ctx);
    const index = await indexConversations(deps.ctx);
    const leads = new Map<string, string>();
    const marked: string[] = [];
    for (const job of jobs) {
        const { id } = job;
        const known = index.get(id) ?? { isUnsettled: false, idleClosedIds: [] };
        await applyRule3(deps, id, known.leadId);
        const { leadId, marked: markedByRule1 } = await applyRule1(deps, id, known.leadId);
        marked.push(...markedByRule1);
        if (leadId !== undefined) leads.set(id, leadId);
        await applyRule2(deps, id, leadId);
        marked.push(...(await applyRule4(deps, job, known)));
    }
    if (deps.options.turnEndRule === false) return marked;
    for (const { id } of jobs) await checkTurnEnd(deps, id, leads.get(id));
    return marked;
}
