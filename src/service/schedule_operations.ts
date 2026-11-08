/**
 * The schedule operations (S-007 REQ-009, REQ-001): `schedules.list` and `schedules.get`, and `schedules.create`, which
 * checks the entry and writes it to the configuration file as one step.
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigValueError } from "../config/config_file.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { HostInvalidKeyError, settingsResultOnce } from "../host/idempotency.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import { DEFAULT_LEAD_ROLE } from "../roles/shipped_roles.ts";
import { checkEntry, type ScheduleEntry } from "../schedules/schedule_model.ts";
import { scheduleSection } from "../schedules/schedule_section.ts";
import { localTimeText, nextDueTime, parseCron } from "../schedules/schedule_time.ts";
import type { SchedulesComponent } from "../schedules/schedules_component.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

const CREATE_SCOPE = "schedules.create";
type CreateInput = { entry: Record<string, unknown>; idempotencyKey?: string };

export type ScheduleView = ScheduleEntry & { nextDueTime: string };

function parseName(raw: unknown): { name: string } {
    const name = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).name : undefined;
    if (typeof name !== "string" || name === "") throw new Error("name must be a non-empty string");
    return { name };
}

function parseCreate(raw: unknown): CreateInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { idempotencyKey, ...entry } = raw as Record<string, unknown>;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
        throw new Error("idempotencyKey must be a string");
    }
    return idempotencyKey === undefined ? { entry } : { entry, idempotencyKey };
}

async function mappingRefusals<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof ConfigValueError) throw new ServiceError("invalid_input", error.message);
        if (error instanceof ConfigChangeRefused) {
            const codes = { invalid: "invalid_input", conflict: "conflict", write_failed: "internal" } as const;
            throw new ServiceError(codes[error.kind], error.message);
        }
        if (error instanceof HostInvalidKeyError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
}

export function scheduleOperations(
    component: Pick<SchedulesComponent, "clock">,
    agents: Pick<AgentsComponent, "runtime">,
) {
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

    // The seat check is the one a fire makes, so a schedule that can't resolve a model is refused when it is created.
    const checkSeat = (entry: ScheduleEntry): void => {
        const overrides = {
            ...(entry.model === undefined ? {} : { model: entry.model }),
            ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
            ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
        };
        try {
            agents.runtime().catalog.seatFor(entry.role ?? DEFAULT_LEAD_ROLE, overrides);
        } catch (error) {
            if (!(error instanceof RoleRefusedError)) throw error;
            const key = error.kind === "not_found" ? "role" : (error.field ?? "role");
            throw new ServiceError("invalid_input", `Schedule entry "${entry.name}" ${key}: ${error.message}`);
        }
    };

    // A crash between the file write and the recorded key leaves the entry in place; the repeat then returns it.
    const createEntry = async (
        { config }: ServiceContext,
        raw: Record<string, unknown>,
        isRepeatable: boolean,
    ): Promise<{ schedule: ScheduleView }> => {
        let created: ScheduleEntry | undefined;
        const existing = (entry: ScheduleEntry) => config.current(scheduleSection).find((c) => c.name === entry.name);
        if (isRepeatable) {
            const entry = checkEntry(raw);
            const same = existing(entry);
            if (same !== undefined && isDeepStrictEqual(same, entry)) return { schedule: view(same) };
        }
        await config.update(scheduleSection, (current) => {
            const entry = checkEntry(raw);
            if (current.some((candidate) => candidate.name === entry.name)) {
                throw new ServiceError("conflict", `There is already a schedule entry named "${entry.name}".`);
            }
            checkSeat(entry);
            created = entry;
            return [...current, entry];
        });
        return { schedule: view(created as ScheduleEntry) };
    };

    const createOperation = defineOperation<ServiceContext, CreateInput, { schedule: ScheduleView }>({
        name: "schedules.create",
        kind: "control",
        parse: parseCreate,
        run: (ctx, { entry, idempotencyKey }) =>
            mappingRefusals(() =>
                idempotencyKey === undefined
                    ? createEntry(ctx, entry, false)
                    : settingsResultOnce(ctx.host, { scope: CREATE_SCOPE, key: idempotencyKey }, () =>
                          createEntry(ctx, entry, true),
                      ),
            ),
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [listOperation, getOperation, createOperation];
    return operations;
}
