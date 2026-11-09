/**
 * The schedules daemon component (S-007): the `schedule` configuration section, the startup check of step 6 that every
 * entry's role exists and its workspace is registered, and the clock the entries are read against.
 */

import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigError, type ConfigSection } from "../config/config_file.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { JobsComponent } from "../jobs/jobs_component.ts";
import { ScheduledRunBusyError } from "../service/job_operations.ts";
import { type Operation, ServiceError } from "../service/operations.ts";
import { scheduleOperations, startScheduledRun } from "../service/schedule_operations.ts";
import { fireKey } from "./schedule_model.ts";
import { scheduleSection } from "./schedule_section.ts";
import { localTimeText } from "./schedule_time.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";

/** What the schedules read time from. A test passes its own; the real one is `Date` and `setTimeout`. */
export type ScheduleClock = {
    now(): Date;
    /** Settles when the clock reaches `until`, or as soon as `signal` aborts. */
    wait(until: Date, signal: AbortSignal): Promise<void>;
};

export type SchedulesComponentOptions = {
    agents: AgentsComponent;
    jobs: JobsComponent;
    logger: Logger;
    clock?: ScheduleClock;
};

export type SchedulesComponent = {
    component: DaemonComponent;
    sections: readonly ConfigSection<unknown>[];
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
    clock: ScheduleClock;
};

const realClock: ScheduleClock = {
    now: () => new Date(),
    wait: (until, signal) =>
        new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
            };
            const timer = setTimeout(done, Math.max(0, until.getTime() - Date.now()));
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
        }),
};

export async function createSchedulesComponent(options: SchedulesComponentOptions): Promise<SchedulesComponent> {
    const { agents } = options;
    let scheduler: Scheduler | undefined;

    const component: DaemonComponent = {
        name: "schedules",
        async start(ctx) {
            scheduler = createScheduler({
                clock: schedules.clock,
                phase: () => ctx.status.phase(),
                entries: () => ctx.config.current(scheduleSection),
                fire: async (entry, dueTime) => {
                    const fireTime = localTimeText(dueTime);
                    try {
                        await startScheduledRun(ctx, options.jobs, entry, {
                            fireTime,
                            idempotencyKey: fireKey(entry.name, fireTime),
                        });
                    } catch (error) {
                        // Failures of the service stay missed due times; the scheduler logs them.
                        if (
                            !(error instanceof ServiceError) ||
                            error.code === "unavailable" ||
                            error.code === "internal"
                        ) {
                            throw error;
                        }
                        await ctx.jobStore.recordSkip({
                            entry: entry.name,
                            dueAt: dueTime.toISOString(),
                            dueTime: fireTime,
                            reason: error.message,
                            openRun: error instanceof ScheduledRunBusyError ? error.openRun : null,
                        });
                    }
                },
                logger: options.logger,
            });
            scheduler.start();
        },
        async stop() {
            await scheduler?.stop();
            scheduler = undefined;
        },
        async checkModels(ctx) {
            const { catalog, workspaces } = agents.runtime();
            const entries = () => ctx.config.current(scheduleSection);
            catalog.addReferenceSource({
                name: "schedules",
                referrersOf: (role) => {
                    const defaults = workspaces
                        .list()
                        .filter((listing) => listing.kind === "role_default" && listing.role === role)
                        .map((listing) => listing.path);
                    return entries()
                        .filter(
                            (entry) =>
                                entry.role === role ||
                                (entry.workspace !== undefined && defaults.includes(entry.workspace)),
                        )
                        .map((entry) => entry.name);
                },
            });
            workspaces.addReferenceSource({
                name: "schedules",
                referrersOf: (path) =>
                    entries()
                        .filter((entry) => entry.workspace === path)
                        .map((entry) => entry.name),
            });
        },
        async ensureWorkspaces(ctx) {
            const { catalog, workspaces } = agents.runtime();
            for (const entry of ctx.config.current(scheduleSection)) {
                const at = (key: string) => `schedule.${entry.name}.${key}`;
                const role = entry.role ?? "bob";
                if (catalog.get(role) === undefined) {
                    throw new ConfigError(ctx.dirs.configFile, `the role "${role}" does not exist`, at("role"));
                }
                if (entry.workspace !== undefined && !workspaces.isRegistered(entry.workspace)) {
                    throw new ConfigError(
                        ctx.dirs.configFile,
                        `the workspace ${entry.workspace} is not registered`,
                        at("workspace"),
                    );
                }
            }
        },
    };

    const schedules: SchedulesComponent = {
        component,
        sections: [scheduleSection],
        operations: [],
        clock: options.clock ?? realClock,
    };
    schedules.operations.push(...scheduleOperations(schedules, agents, options.jobs));
    return schedules;
}
