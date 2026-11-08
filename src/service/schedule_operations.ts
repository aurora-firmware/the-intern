/**
 * The schedule operations (S-007 REQ-009, REQ-001): `schedules.list` and `schedules.get`, and `schedules.create`,
 * `schedules.change` and `schedules.remove`, which check the entry and write the configuration file as one step.
 */
import { stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigValueError } from "../config/config_file.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { HostInvalidKeyError, settingsResultOnce } from "../host/idempotency.ts";
import type { JobOriginOnDemand } from "../jobs/job_model.ts";
import type { JobsComponent } from "../jobs/jobs_component.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import type { Seat } from "../roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../roles/shipped_roles.ts";
import { checkEntry, type ScheduleEntry } from "../schedules/schedule_model.ts";
import { scheduleSection } from "../schedules/schedule_section.ts";
import { localTimeText, nextDueTime, parseCron } from "../schedules/schedule_time.ts";
import type { SchedulesComponent } from "../schedules/schedules_component.ts";
import { createJob, type JobView } from "./job_operations.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

const CLEARABLE_KEYS = ["role", "model", "thinkingLevel", "workspace"];
const CREATE_SCOPE = "schedules.create";
type CreateInput = { entry: Record<string, unknown>; idempotencyKey?: string };
type ChangeInput = { name: string; change: Record<string, unknown> };

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

function parseChange(raw: unknown): ChangeInput {
    const { name } = parseName(raw);
    const { name: _name, ...change } = raw as Record<string, unknown>;
    return { name, change };
}

// A value absent from the change stays; `null` clears an optional value. For any other key `null` stays in the merge,
// so the check refuses a required value as not text and an unknown key as not a schedule setting.
function mergeChange(entry: ScheduleEntry, change: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...entry };
    for (const [key, value] of Object.entries(change)) {
        if (value === undefined) continue;
        if (value === null && CLEARABLE_KEYS.includes(key)) delete merged[key];
        else merged[key] = value;
    }
    return merged;
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

export type ScheduledRunOptions = { fireTime: string; onDemand?: JobOriginOnDemand; idempotencyKey?: string };

const SCHEDULE_SOURCE = { kind: "job_source", source: "schedule" } as const;

async function requireFolder(path: string): Promise<void> {
    const found = await stat(path).then(
        (info) => info.isDirectory(),
        () => false,
    );
    if (!found) throw new ServiceError("invalid_input", `The workspace folder ${path} does not exist.`);
}

/**
 * Starts the job of a schedule entry: a fire and a run on demand make the same checks here, and differ only in what
 * they do with a refusal (S-007 REQ-006, REQ-008). The entry's values are stored with the job when it is written, so a
 * later change of the entry leaves the running job as it was (REQ-003).
 */
export async function startScheduledRun(
    ctx: ServiceContext,
    jobs: Pick<JobsComponent, "options">,
    entry: ScheduleEntry,
    options: ScheduledRunOptions,
): Promise<JobView> {
    const overrides = {
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
        ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
    };
    let seat: Seat;
    try {
        seat = jobs.options.agents.runtime().catalog.seatFor(entry.role ?? DEFAULT_LEAD_ROLE, overrides);
    } catch (error) {
        if (error instanceof RoleRefusedError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
    await requireFolder(seat.workspace);
    const origin = {
        kind: "schedule",
        entry: entry.name,
        fireTime: options.fireTime,
        ...(options.onDemand !== undefined && { onDemand: options.onDemand }),
    };
    return createJob(
        ctx,
        jobs.options,
        {
            text: entry.request,
            ...(entry.role !== undefined && { role: entry.role }),
            ...overrides,
            origin,
            ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        },
        { actor: SCHEDULE_SOURCE },
    );
}

export function scheduleOperations(
    component: Pick<SchedulesComponent, "clock">,
    agents: Pick<AgentsComponent, "runtime">,
) {
    const view = (entry: ScheduleEntry): ScheduleView => ({
        ...entry,
        nextDueTime: localTimeText(nextDueTime(parseCron(entry.cron), component.clock.now())),
    });

    const missing = (name: string) => new ServiceError("not_found", `There is no schedule entry named "${name}".`);

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
            if (entry === undefined) throw missing(name);
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

    const changeOperation = defineOperation<ServiceContext, ChangeInput, { schedule: ScheduleView }>({
        name: "schedules.change",
        kind: "control",
        parse: parseChange,
        run: ({ config }, { name, change }) =>
            mappingRefusals(async () => {
                let changed: ScheduleEntry | undefined;
                await config.update(scheduleSection, (current) => {
                    const entry = current.find((candidate) => candidate.name === name);
                    if (entry === undefined) throw missing(name);
                    const merged = checkEntry(mergeChange(entry, change));
                    checkSeat(merged);
                    changed = merged;
                    return current.map((candidate) => (candidate === entry ? merged : candidate));
                });
                return { schedule: view(changed as ScheduleEntry) };
            }),
    });

    const removeOperation = defineOperation<ServiceContext, { name: string }, Record<string, never>>({
        name: "schedules.remove",
        kind: "control",
        parse: parseName,
        run: ({ config }, { name }) =>
            mappingRefusals(async () => {
                await config.update(scheduleSection, (current) => {
                    if (!current.some((candidate) => candidate.name === name)) throw missing(name);
                    return current.filter((candidate) => candidate.name !== name);
                });
                return {};
            }),
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [
        listOperation,
        getOperation,
        createOperation,
        changeOperation,
        removeOperation,
    ];
    return operations;
}
