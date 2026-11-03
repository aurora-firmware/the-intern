/**
 * The Jobs daemon component (S-004): the job operations and the test-only hook that is awaited at each point where a
 * job write has committed and the work that follows it has not begun.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import { onInputSubmitted } from "../host/conversation_control.ts";
import { setJobDoneCheck } from "../host/job_section.ts";
import { readConversationMeta } from "../host/seating.ts";
import { jobActionOperations } from "../service/job_action_operations.ts";
import { jobExportOperation } from "../service/job_export_operation.ts";
import { createJob, createJobOperation } from "../service/job_operations.ts";
import { jobRecordOperations } from "../service/job_record_operations.ts";
import type { Operation } from "../service/operations.ts";
import { resumeAfterLeadInput, startJob } from "./job_actions.ts";
import { repairJobs } from "./job_repair.ts";
import { JobNotFoundError } from "./job_store.ts";
import { createJobToolsExtension } from "./job_tools_extension.ts";
import { startTurnEndRule } from "./turn_end_rule.ts";

export type WritePoint =
    | "job-created"
    | "lead-created"
    | "job-blocked"
    | "job-completed"
    | "job-cancelled"
    | "lead-input"
    | "turn-ended";

export type JobsComponentOptions = {
    agents: AgentsComponent;
    logger: Logger;
    /** Test-only: awaited at each write point, so a test can act between a write and what follows it. */
    afterWrite?: (point: WritePoint, jobId: string) => void | Promise<void>;
    /** Test-only, `true` by default: `false` applies no turn-end rule, for tests about conversations, not jobs. */
    turnEndRule?: boolean;
};

export type JobsComponent = {
    component: DaemonComponent;
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
    options: JobsComponentOptions;
};

/**
 * Writes the job's start when its lead takes a worker thread (S-004 REQ-005). The lead's job ID may be absent from the
 * job store (tests seat leads directly), and then the grant writes nothing.
 */
async function startJobOfLead(ctx: ServiceContext, options: JobsComponentOptions, conversationId: string) {
    const meta = await readConversationMeta(ctx.host, conversationId);
    if (!meta?.isLead || meta.jobId === null) return;
    try {
        const job = await ctx.jobStore.getJob(meta.jobId);
        if (job.status === "to_do") await startJob({ ctx, options }, job.id);
    } catch (error) {
        if (!(error instanceof JobNotFoundError)) throw error;
    }
}

export async function createJobsComponent(options: JobsComponentOptions): Promise<JobsComponent> {
    let stopListening: (() => void) | undefined;
    let stopInputListening: (() => void) | undefined;
    let stopTurnEndRule: (() => void) | undefined;
    let stopJobDoneCheck: (() => void) | undefined;
    let context: ServiceContext | undefined;
    // The job tools are built before the host opens, so they reach the service context once startup has bound it.
    const requireContext = (): ServiceContext => {
        if (context === undefined) throw new Error("The service context exists only after startup step 4");
        return context;
    };
    const jobTools = createJobToolsExtension({
        host: () => requireContext().host,
        jobStore: () => requireContext().jobStore,
        createJob: (request, caller) => createJob(requireContext(), options, request, caller),
        actions: () => ({ ctx: requireContext(), options }),
    });
    return {
        component: {
            name: "jobs",
            extensions: [jobTools],
            // Step 5 comes before work resumes, so runs that resume after a restart are covered.
            async checkModels(ctx) {
                context = ctx;
                stopJobDoneCheck = setJobDoneCheck(ctx.host, async (jobId) => {
                    try {
                        return (await ctx.jobStore.getJob(jobId)).status === "done";
                    } catch (error) {
                        if (error instanceof JobNotFoundError) return false;
                        throw error;
                    }
                });
                stopListening = ctx.admission.onGranted((conversationId) =>
                    startJobOfLead(ctx, options, conversationId),
                );
                stopInputListening = onInputSubmitted(ctx.host, (input) =>
                    resumeAfterLeadInput({ ctx, options }, input),
                );
                if (options.turnEndRule !== false) {
                    const rule = startTurnEndRule({ ctx, options });
                    stopTurnEndRule = rule.stop;
                    await rule.ready;
                }
            },
            // Step 7: after admission is restored and before work resumes (S-004 REQ-018).
            async repair(ctx) {
                await repairJobs({ ctx, options });
            },
            async stop() {
                stopJobDoneCheck?.();
                stopJobDoneCheck = undefined;
                stopListening?.();
                stopListening = undefined;
                stopInputListening?.();
                stopInputListening = undefined;
                stopTurnEndRule?.();
                stopTurnEndRule = undefined;
                context = undefined;
            },
        },
        operations: [
            createJobOperation(options),
            ...jobRecordOperations(options),
            ...jobActionOperations(options),
            jobExportOperation,
        ],
        options,
    };
}
