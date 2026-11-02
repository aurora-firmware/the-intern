/**
 * The operations on a job's record (S-004 REQ-002, REQ-004, REQ-009, REQ-010, REQ-011, REQ-014): read one job, list
 * jobs, edit the editable fields, add to and page the worklog, page the history, and relate and unrelate two jobs.
 * Every job is named by its ID or its short number in any letter case; the store resolves both.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { readConversationMeta } from "../host/seating.ts";
import { EDITABLE_FIELDS, type JobAuthor, type JobStatus, type Letter } from "../jobs/job_model.ts";
import {
    type HistoryEntry,
    type Job,
    JobNotFoundError,
    JobRefusedError,
    type WorklogEntry,
} from "../jobs/job_store.ts";
import type { JobsComponentOptions } from "../jobs/jobs_component.ts";
import { leadConversationOf } from "./job_operations.ts";
import { type Caller, defineOperation, type Operation, ServiceError } from "./operations.ts";

const IN_PROCESS_WAY_IN = "in-process";
const STATUSES: readonly string[] = ["to_do", "in_progress", "blocked", "done"];
const LETTERS: readonly string[] = ["C", "W", "E", "S", "T", "A"];
const STORE_PAGE_SIZE = 500;

type JobDetail = Job & { leadConversation?: string; worklog: WorklogEntry[]; history: HistoryEntry[] };
type PageInput = { job: string; limit?: number; cursor?: string };
type ListInput = { status?: JobStatus; letter?: Letter; relatedTo?: string; limit?: number; cursor?: string };
type UpdateInput = { job: string; fields: Record<string, unknown> };
type PairInput = { job: string; other: string };

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
    return value;
}

function parseLimit(record: Record<string, unknown>): { limit?: number } {
    const { limit } = record;
    if (limit === undefined) return {};
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > STORE_PAGE_SIZE) {
        throw new Error(`limit must be a whole number from 1 to ${STORE_PAGE_SIZE}`);
    }
    return { limit };
}

function parsePage(raw: unknown): PageInput {
    const record = asRecord(raw);
    const input: PageInput = { job: requireString(record, "job"), ...parseLimit(record) };
    if (record.cursor !== undefined) input.cursor = requireString(record, "cursor");
    return input;
}

function parseOneOf<T extends string>(record: Record<string, unknown>, field: string, allowed: readonly string[]): T {
    const value = requireString(record, field);
    if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
    return value as T;
}

function parseList(raw: unknown): ListInput {
    const record = asRecord(raw);
    const input: ListInput = parseLimit(record);
    if (record.status !== undefined) input.status = parseOneOf<JobStatus>(record, "status", STATUSES);
    if (record.letter !== undefined) input.letter = parseOneOf<Letter>(record, "letter", LETTERS);
    if (record.relatedTo !== undefined) input.relatedTo = requireString(record, "relatedTo");
    if (record.cursor !== undefined) input.cursor = requireString(record, "cursor");
    return input;
}

// A field that isn't editable is kept as named, so the store refuses it by name before it changes anything.
function parseUpdate(raw: unknown): UpdateInput {
    const { job, ...fields } = asRecord(raw);
    if (typeof job !== "string" || job === "") throw new Error("job must be a non-empty string");
    for (const name of EDITABLE_FIELDS) {
        if (fields[name] !== undefined && typeof fields[name] !== "string") throw new Error(`${name} must be a string`);
    }
    return { job, fields };
}

function parsePair(raw: unknown): PairInput {
    const record = asRecord(raw);
    return { job: requireString(record, "job"), other: requireString(record, "other") };
}

/**
 * Who a write is authored by (S-004 Interfaces): the team member with the way in the listener recorded, or the agent
 * with its conversation and the role its conversation was seated with. A job source never edits or acts on a job.
 */
export async function authorOf(caller: Caller, host: HarnessHost): Promise<JobAuthor> {
    const { actor } = caller;
    if (actor.kind === "job_source") {
        throw new ServiceError("invalid_input", `Job source ${actor.source} cannot edit a job or act on one`);
    }
    if (actor.kind === "team_member") {
        return {
            kind: "team_member",
            wayIn: actor.wayIn ?? IN_PROCESS_WAY_IN,
            ...(actor.observed && { observed: actor.observed }),
        };
    }
    const meta = await readConversationMeta(host, actor.conversationId);
    if (meta === undefined) {
        throw new ServiceError("not_found", `There is no conversation ${actor.conversationId}`);
    }
    return { kind: "agent", conversationId: actor.conversationId, role: meta.seat.role };
}

// A store refusal is a service refusal of the same code; a bad cursor is the caller's input.
async function refusing<T>(action: Promise<T>): Promise<T> {
    try {
        return await action;
    } catch (error) {
        if (error instanceof JobRefusedError) throw new ServiceError(error.code, error.message);
        if (error instanceof JobNotFoundError) throw new ServiceError("not_found", error.message);
        if (error instanceof RangeError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
}

async function allEntries<T>(
    page: (cursor: string | undefined) => Promise<{ entries: T[]; cursor?: string }>,
): Promise<T[]> {
    const entries: T[] = [];
    let cursor: string | undefined;
    do {
        const next = await page(cursor);
        entries.push(...next.entries);
        cursor = next.cursor;
    } while (cursor !== undefined);
    return entries;
}

async function readJob(ctx: ServiceContext, ref: string): Promise<JobDetail> {
    const { jobStore, host } = ctx;
    const job = await jobStore.getJob(ref);
    const pageAt = (cursor: string | undefined) => ({ limit: STORE_PAGE_SIZE, ...(cursor && { cursor }) });
    const worklog = await allEntries((cursor) => jobStore.listWorklog(job.id, pageAt(cursor)));
    const history = await allEntries((cursor) => jobStore.listHistory(job.id, pageAt(cursor)));
    const leadConversation = await leadConversationOf(host, job.id);
    return { ...job, ...(leadConversation !== undefined && { leadConversation }), worklog, history };
}

const pageOf = ({ limit, cursor }: PageInput) => ({
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor }),
});

export function jobRecordOperations(_options: JobsComponentOptions) {
    const get = defineOperation<ServiceContext, { job: string }, JobDetail>({
        name: "jobs.get",
        kind: "read",
        parse: (raw) => ({ job: requireString(asRecord(raw), "job") }),
        run: (ctx, input) => refusing(readJob(ctx, input.job)),
    });
    const list = defineOperation<ServiceContext, ListInput, { jobs: Job[]; cursor?: string }>({
        name: "jobs.list",
        kind: "read",
        parse: parseList,
        run: (ctx, input) => refusing(ctx.jobStore.listJobs(input)),
    });
    const update = defineOperation<ServiceContext, UpdateInput, Job>({
        name: "jobs.update",
        kind: "control",
        parse: parseUpdate,
        async run(ctx, input, caller) {
            const author = await authorOf(caller, ctx.host);
            return refusing(ctx.jobStore.updateFields(input.job, input.fields, author));
        },
    });
    const worklogAdd = defineOperation<ServiceContext, { job: string; text: string }, WorklogEntry>({
        name: "jobs.worklog.add",
        kind: "control",
        parse: (raw) => {
            const record = asRecord(raw);
            return { job: requireString(record, "job"), text: requireString(record, "text") };
        },
        async run(ctx, input, caller) {
            const author = await authorOf(caller, ctx.host);
            return refusing(ctx.jobStore.addWorklog(input.job, input.text, author));
        },
    });
    const worklogList = defineOperation<ServiceContext, PageInput, { entries: WorklogEntry[]; cursor?: string }>({
        name: "jobs.worklog.list",
        kind: "read",
        parse: parsePage,
        run: (ctx, input) => refusing(ctx.jobStore.listWorklog(input.job, pageOf(input))),
    });
    const historyList = defineOperation<ServiceContext, PageInput, { entries: HistoryEntry[]; cursor?: string }>({
        name: "jobs.history.list",
        kind: "read",
        parse: parsePage,
        run: (ctx, input) => refusing(ctx.jobStore.listHistory(input.job, pageOf(input))),
    });
    const link = (name: "jobs.relate" | "jobs.unrelate", method: "relate" | "unrelate") =>
        defineOperation<ServiceContext, PairInput, { a: Job; b: Job }>({
            name,
            kind: "control",
            parse: parsePair,
            async run(ctx, input, caller) {
                const author = await authorOf(caller, ctx.host);
                return refusing(ctx.jobStore[method](input.job, input.other, author));
            },
        });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [
        get,
        list,
        update,
        worklogAdd,
        worklogList,
        historyList,
        link("jobs.relate", "relate"),
        link("jobs.unrelate", "unrelate"),
    ];
    return operations;
}
