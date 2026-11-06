/**
 * The turn-end rule (S-004 REQ-008): when a lead's turn ends with its job In progress and nothing left to wait for,
 * the daemon either reminds the lead once or blocks the job. The daemon is the actor of the reminder and the author of
 * the block (S-001 v0.7 REQ-007).
 */
import { hasQueuedUserInput, hasSubmissionWithRequestId, isStopMarkLive } from "../host/conversation_control.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { watchInstance } from "../host/host_observation.ts";
import { readConversationMeta } from "../host/seating.ts";
import { type SteerInput, steerConversation } from "../host/steering.ts";
import { leadConversationOf } from "../service/job_operations.ts";
import { allEntries, STORE_PAGE_SIZE } from "../service/job_record_operations.ts";
import { blockJob, type JobActionDeps } from "./job_actions.ts";
import { blockResumeCount, reminderRequestId, turnEndDecision } from "./job_model.ts";
import { JobNotFoundError } from "./job_store.ts";

/** What the reminder asks of the lead. */
export const REMINDER_TEXT =
    "Your turn ended, but the job is still In progress. Continue the work, block the job with block_job if you " +
    "cannot go on, or complete it with complete_job.";

// The lead waits for something while it is parked, awaits invoked conversations, runs, or has input queued; an
// invoked conversation of the job that runs is work the lead is waiting on too. A queued entry write, such as a reset
// that an abort left behind, is not input the lead will act on, so it is not waited for.
async function isLeadWaiting(deps: JobActionDeps, jobId: string, leadId: string): Promise<boolean> {
    const { host } = deps.ctx;
    const meta = await readConversationMeta(host, leadId);
    if (meta === undefined || meta.parked !== null || meta.awaiting.length > 0) return true;
    if ((await host.conversationInfo(leadId))?.busy !== false) return true;
    if (await hasQueuedUserInput(host, leadId)) return true;
    for (const { id, busy } of await host.listConversations()) {
        if (busy && id !== leadId && (await readConversationMeta(host, id))?.jobId === jobId) return true;
    }
    return false;
}

// A team member's stop of the lead's run leaves a live stop mark, which blocks the job without a reminder.
async function isLeadStopped(host: HarnessHost, leadId: string): Promise<boolean> {
    const meta = await readConversationMeta(host, leadId);
    return meta !== undefined && (await isStopMarkLive(host, leadId, meta));
}

async function isJobLeadStopped(host: HarnessHost, jobId: string): Promise<boolean> {
    const leadId = await leadConversationOf(host, jobId);
    return leadId !== undefined && (await isLeadStopped(host, leadId));
}

/** A reminder the rule owes a lead conversation. */
export type PendingReminder = { leadId: string; input: SteerInput };

/** Submits a reminder. Submitting turns scheduling on, so the startup repair does it only after the host resumes. */
export async function submitReminder(host: HarnessHost, reminder: PendingReminder): Promise<void> {
    await steerConversation(host, reminder.leadId, reminder.input);
}

/**
 * Judges the job once its lead has stopped, and blocks it when the rule says so. It acts only for a job that the job
 * store holds, that is In progress, and whose lead waits for nothing. A reminder is spent when pi-durable already holds
 * a submission with its request id, which names the number of times the job has blocked or resumed. A caller that
 * already knows the job's lead conversation passes it, so the check does not look it up again. Returns the reminder
 * the lead is owed, which the caller submits.
 */
export async function evaluateTurnEnd(
    deps: JobActionDeps,
    jobId: string,
    knownLeadId?: string,
): Promise<PendingReminder | undefined> {
    const { ctx } = deps;
    const job = await ctx.jobStore.getJob(jobId).catch((error: unknown) => {
        if (error instanceof JobNotFoundError) return undefined;
        throw error;
    });
    if (job === undefined || job.status !== "in_progress") return undefined;
    const leadId = knownLeadId ?? (await leadConversationOf(ctx.host, job.id));
    if (leadId === undefined || (await isLeadWaiting(deps, job.id, leadId))) return undefined;

    const history = await allEntries((cursor) =>
        ctx.jobStore.listHistory(job.id, { limit: STORE_PAGE_SIZE, ...(cursor && { cursor }) }),
    );
    const requestId = reminderRequestId(job.id, blockResumeCount(history));
    const decision = turnEndDecision({
        definitionOfDone: job.definitionOfDone,
        isReminderSpent: await hasSubmissionWithRequestId(ctx.host, leadId, requestId),
        isStopped: await isLeadStopped(ctx.host, leadId),
    });
    if (decision.kind === "block") {
        await blockJob(deps, job.id, decision.reason, { kind: "daemon" });
        return undefined;
    }
    return { leadId, input: { content: REMINDER_TEXT, mode: "followUp", actor: { kind: "daemon" }, requestId } };
}

/** Applies the rule to the job once its lead has stopped: blocks the job or submits the reminder. */
export async function checkTurnEnd(deps: JobActionDeps, jobId: string, knownLeadId?: string): Promise<void> {
    const reminder = await evaluateTurnEnd(deps, jobId, knownLeadId);
    if (reminder !== undefined) await submitReminder(deps.ctx.host, reminder);
}

/**
 * Checks the job of each lead conversation whose run finishes, and of another conversation of a job whose lead is
 * stopped, and of each lead handed to `leadStopped`, one at a time in the order the runs finished. `ready`
 * settles once the watch is in place, so runs that resume after a restart are seen.
 */
export function startTurnEndRule(deps: JobActionDeps): {
    stop(): void;
    ready: Promise<void>;
    leadStopped(leadId: string): void;
} {
    const { ctx, options } = deps;
    let queue: Promise<void> = Promise.resolve();
    let isStopped = false;
    const check = async (conversationId: string): Promise<void> => {
        if (isStopped) return;
        const meta = await readConversationMeta(ctx.host, conversationId);
        if (meta === undefined || meta.jobId === null) return;
        // The run of another conversation of the job matters only when its lead is stopped, which nothing else ends.
        if (!meta.isLead && !(await isJobLeadStopped(ctx.host, meta.jobId))) return;
        await options.afterWrite?.("turn-ended", meta.jobId);
        await checkTurnEnd(deps, meta.jobId);
    };
    const enqueue = (conversationId: string): void => {
        queue = queue.then(() =>
            check(conversationId).catch((error: unknown) => {
                options.logger.error("turn-end check failed", {
                    conversation: conversationId,
                    cause: error instanceof Error ? error.message : String(error),
                });
            }),
        );
    };
    const watching = watchInstance(ctx.host, (event) => {
        if (event.type === "run_finished") enqueue(event.conversationId);
    });
    return {
        stop() {
            isStopped = true;
            watching.then((watch) => watch.stop()).catch(() => undefined);
        },
        ready: watching.then(() => undefined),
        leadStopped: enqueue,
    };
}
