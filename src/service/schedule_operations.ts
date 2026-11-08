/** The schedule read operations (S-007 REQ-009): `schedules.list` and `schedules.get`. */
import type { ServiceContext } from "../daemon/daemon.ts";
import type { ScheduleEntry } from "../schedules/schedule_model.ts";
import { scheduleSection } from "../schedules/schedule_section.ts";
import { localTimeText, nextDueTime, parseCron } from "../schedules/schedule_time.ts";
import type { SchedulesComponent } from "../schedules/schedules_component.ts";
import { defineOperation, ServiceError } from "./operations.ts";

export type ScheduleView = ScheduleEntry & { nextDueTime: string };

function parseName(raw: unknown): { name: string } {
    const name = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).name : undefined;
    if (typeof name !== "string" || name === "") throw new Error("name must be a non-empty string");
    return { name };
}

export function scheduleOperations(component: Pick<SchedulesComponent, "clock">) {
    const view = (entry: ScheduleEntry): ScheduleView => ({
        ...entry,
        nextDueTime: localTimeText(nextDueTime(parseCron(entry.cron), component.clock.now())),
    });

    const listOperation = defineOperation<ServiceContext, Record<string, never>, { schedules: ScheduleView[] }>({
        name: "schedules.list",
        kind: "read",
        parse: () => ({}),
        run: async ({ config }) => ({ schedules: config.current(scheduleSection).map(view) }),
    });

    const getOperation = defineOperation<ServiceContext, { name: string }, { schedule: ScheduleView }>({
        name: "schedules.get",
        kind: "read",
        parse: parseName,
        run: async ({ config }, { name }) => {
            const entry = config.current(scheduleSection).find((candidate) => candidate.name === name);
            if (entry === undefined) throw new ServiceError("not_found", `There is no schedule entry named "${name}".`);
            return { schedule: view(entry) };
        },
    });

    return [listOperation, getOperation];
}
