/**
 * The Jobs daemon component (S-004): the job operations and the test-only hook that is awaited at each point where a
 * job write has committed and the work that follows it has not begun.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import { createJobOperation } from "../service/job_operations.ts";
import type { Operation } from "../service/operations.ts";

export type WritePoint =
    | "job-created"
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
};

export type JobsComponent = {
    component: DaemonComponent;
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
    options: JobsComponentOptions;
};

export async function createJobsComponent(options: JobsComponentOptions): Promise<JobsComponent> {
    return {
        component: { name: "jobs" },
        operations: [createJobOperation(options)],
        options,
    };
}
