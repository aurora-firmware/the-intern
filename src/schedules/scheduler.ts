/**
 * The scheduler (S-007 REQ-007, REQ-015): it wakes at each whole minute and starts a fire for each due time that fell
 * within the last minute and since the previous check. It holds nothing but `checkedUntil`, so a sleep or a stall gives
 * up the older due times and the daemon never needs to see one. See `docs/development/architecture.md`, "The scheduler".
 */

import type { Logger } from "../daemon/logger.ts";
import type { DaemonPhase } from "../service/operations.ts";
import type { ScheduleEntry } from "./schedule_model.ts";
import { nextDueTime, parseCron } from "./schedule_time.ts";
import type { ScheduleClock } from "./schedules_component.ts";

const MINUTE_MS = 60_000;

export type SchedulerOptions = {
    clock: ScheduleClock;
    phase(): DaemonPhase;
    /** The current list of entries, read at each tick. */
    entries(): readonly ScheduleEntry[];
    /** Starts one fire. The scheduler never waits for it in a tick. */
    fire(entry: ScheduleEntry, dueTime: Date): Promise<void>;
    logger: Logger;
};

export type Scheduler = {
    start(): void;
    /** Ends the wait and resolves after the fires in flight settle. */
    stop(): Promise<void>;
};

const nextWholeMinute = (now: Date): Date => new Date((Math.floor(now.getTime() / MINUTE_MS) + 1) * MINUTE_MS);

export function createScheduler(options: SchedulerOptions): Scheduler {
    const { clock, logger } = options;
    const inFlight = new Set<Promise<void>>();
    let abort: AbortController | undefined;
    let loop: Promise<void> | undefined;
    let checkedUntil = clock.now();

    const startFire = (entry: ScheduleEntry, dueTime: Date): void => {
        const fire = Promise.resolve()
            .then(() => options.fire(entry, dueTime))
            .catch((error: unknown) => {
                logger.error("A schedule fire failed", {
                    entry: entry.name,
                    dueTime: dueTime.toISOString(),
                    error: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => inFlight.delete(fire));
        inFlight.add(fire);
    };

    const fireEntry = (entry: ScheduleEntry, from: Date, to: Date): void => {
        try {
            const cron = parseCron(entry.cron);
            for (let due = nextDueTime(cron, from); due.getTime() <= to.getTime(); due = nextDueTime(cron, due)) {
                startFire(entry, due);
            }
        } catch (error) {
            logger.error("A schedule entry could not be checked", {
                entry: entry.name,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const tick = (now: Date): void => {
        if (options.phase() !== "ready") {
            checkedUntil = now;
            return;
        }
        const earlier = Math.min(checkedUntil.getTime(), now.getTime());
        const from = new Date(Math.max(now.getTime() - MINUTE_MS, earlier));
        for (const entry of options.entries()) fireEntry(entry, from, now);
        checkedUntil = now;
    };

    const run = async (signal: AbortSignal): Promise<void> => {
        while (!signal.aborted) {
            await clock.wait(nextWholeMinute(clock.now()), signal);
            if (signal.aborted) return;
            tick(clock.now());
        }
    };

    return {
        start() {
            if (abort) return;
            checkedUntil = clock.now();
            abort = new AbortController();
            loop = run(abort.signal);
        },
        async stop() {
            abort?.abort();
            await loop;
            await Promise.all([...inFlight]);
        },
    };
}
