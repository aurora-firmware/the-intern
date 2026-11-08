/**
 * The schedules daemon component (S-007): the `schedule` configuration section, the startup check of step 6 that every
 * entry's role exists and its workspace is registered, and the clock the entries are read against.
 */

import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigError, type ConfigSection } from "../config/config_file.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { JobsComponent } from "../jobs/jobs_component.ts";
import type { Operation } from "../service/operations.ts";
import { scheduleOperations } from "../service/schedule_operations.ts";
import { scheduleSection } from "./schedule_section.ts";

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

    const component: DaemonComponent = {
        name: "schedules",
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
    schedules.operations.push(...scheduleOperations(schedules));
    return schedules;
}
