// The job store (S-004 REQ-001, REQ-002, REQ-014; ADR-001 decision 1): the job record in the-intern's own `intern_`
// tables in the instance's SQLite file. It uses only `HostDatabase`, so it imports no pi package, and it never
// touches pi-durable's tables. The job schema version lives in `intern_schema`, never in the file's `user_version`.

import { randomUUID } from "node:crypto";
import type { HostDatabase, HostSqlExecutor, HostSqlValue } from "../host/harness_host.ts";
import {
    formatNumber,
    type JobOrigin,
    type JobStatus,
    type Letter,
    parseJobRef,
    type Resolution,
} from "./job_model.ts";

export const JOB_SCHEMA_VERSION = 1;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export class JobSchemaTooNewError extends Error {
    readonly fileVersion: number;
    readonly supportedVersion: number;

    constructor(fileVersion: number) {
        super(
            `The database file holds job schema version ${fileVersion}, newer than the version ${JOB_SCHEMA_VERSION} ` +
                "this release supports. Use a newer release; nothing was changed.",
        );
        this.name = "JobSchemaTooNewError";
        this.fileVersion = fileVersion;
        this.supportedVersion = JOB_SCHEMA_VERSION;
    }
}

export class JobNotFoundError extends Error {
    readonly ref: string;

    constructor(ref: string) {
        super(`No job matches ${JSON.stringify(ref)}.`);
        this.name = "JobNotFoundError";
        this.ref = ref;
    }
}

export type Job = {
    id: string;
    number: string;
    createdAt: string;
    updatedAt: string;
    doneAt?: string;
    request: { text: string; origin: JobOrigin };
    statedBy?: string;
    title: string;
    description: string;
    definitionOfDone: string;
    status: JobStatus;
    blockedReason?: string;
    resolution?: Resolution;
    related: string[];
};

export type NewJob = {
    letter: Letter;
    requestText: string;
    origin: JobOrigin;
    title?: string;
    statedBy?: string;
    idempotencyKey?: string;
    /** The role, model, thinking level and workspace overrides and the seat actor the lead starts with. Opaque here. */
    leadStart: unknown;
};

export type JobListFilter = {
    status?: JobStatus;
    letter?: Letter;
    relatedTo?: string;
    limit?: number;
    cursor?: string;
};

export type JobChange = { type: "job_created"; job: Job };

export type JobStore = {
    insertJob(input: NewJob): Promise<{ job: Job; created: boolean }>;
    getJob(ref: string): Promise<Job>;
    listJobs(filter: JobListFilter): Promise<{ jobs: Job[]; cursor?: string }>;
    leadStartOf(ref: string): Promise<unknown>;
    /** Reports each change after its transaction commits. Returns the function that removes the listener. */
    onCommit(listener: (change: JobChange) => void): () => void;
};

export type JobStoreOptions = {
    /** Called when a commit listener throws. The write has committed and stays committed. */
    onListenerError?: (error: unknown) => void;
};

const MIGRATIONS: readonly string[] = [
    `
    CREATE TABLE intern_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
    );
    CREATE TABLE intern_jobs (
        id TEXT PRIMARY KEY,
        letter TEXT NOT NULL,
        n INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        definition_of_done TEXT NOT NULL,
        status TEXT NOT NULL,
        blocked_reason TEXT,
        resolution_kind TEXT,
        resolution_justification TEXT,
        request_text TEXT NOT NULL,
        origin TEXT NOT NULL,
        stated_by TEXT,
        lead_start TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT,
        UNIQUE (letter, n)
    );
    CREATE INDEX intern_jobs_by_status ON intern_jobs (status, created_at);
    CREATE INDEX intern_jobs_by_letter ON intern_jobs (letter, created_at);
    CREATE INDEX intern_jobs_by_created ON intern_jobs (created_at);
    CREATE TABLE intern_counters (
        letter TEXT PRIMARY KEY,
        last_value INTEGER NOT NULL
    );
    CREATE TABLE intern_worklog (
        job TEXT NOT NULL REFERENCES intern_jobs (id),
        sequence INTEGER NOT NULL,
        at TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (job, sequence)
    );
    CREATE TABLE intern_history (
        job TEXT NOT NULL REFERENCES intern_jobs (id),
        sequence INTEGER NOT NULL,
        at TEXT NOT NULL,
        author TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        PRIMARY KEY (job, sequence)
    );
    CREATE TABLE intern_related (
        job_a TEXT NOT NULL REFERENCES intern_jobs (id),
        job_b TEXT NOT NULL REFERENCES intern_jobs (id),
        PRIMARY KEY (job_a, job_b),
        CHECK (job_a < job_b)
    );
    CREATE INDEX intern_related_by_b ON intern_related (job_b);
    `,
];

if (MIGRATIONS.length !== JOB_SCHEMA_VERSION) throw new Error("JOB_SCHEMA_VERSION and MIGRATIONS are out of step");

async function versionIn(executor: HostSqlExecutor): Promise<number> {
    const table = await executor.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'intern_schema'",
    );
    if (!table) return 0;
    const row = await executor.get<{ version: number }>("SELECT version FROM intern_schema WHERE id = 1");
    return row?.version ?? 0;
}

/** The job schema version of the file: 0 when there is no `intern_schema` table. */
export function readJobSchemaVersion(db: HostDatabase): Promise<number> {
    return versionIn(db);
}

/** Throws `JobSchemaTooNewError` when the file's job schema is newer than this release's. Writes nothing. */
export async function checkJobSchemaVersion(db: HostDatabase): Promise<void> {
    const version = await versionIn(db);
    if (version > JOB_SCHEMA_VERSION) throw new JobSchemaTooNewError(version);
}

const SET_VERSION_SQL =
    "INSERT INTO intern_schema (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version";

/** Runs the missing migrations in one transaction. A file that is already current is left unchanged. */
export async function migrateJobStore(db: HostDatabase): Promise<void> {
    await db.transaction(async (tx) => {
        const version = await versionIn(tx);
        if (version > JOB_SCHEMA_VERSION) throw new JobSchemaTooNewError(version);
        for (let next = version + 1; next <= JOB_SCHEMA_VERSION; next++) {
            await tx.exec(MIGRATIONS[next - 1] as string);
            await tx.run(SET_VERSION_SQL, next);
        }
    });
}

type JobRow = {
    id: string;
    letter: Letter;
    n: number;
    title: string;
    description: string;
    definition_of_done: string;
    status: JobStatus;
    blocked_reason: string | null;
    resolution_kind: Resolution["kind"] | null;
    resolution_justification: string | null;
    request_text: string;
    origin: string;
    stated_by: string | null;
    created_at: string;
    updated_at: string;
    done_at: string | null;
};

const JOB_COLUMNS = `id, letter, n, title, description, definition_of_done, status, blocked_reason, resolution_kind,
    resolution_justification, request_text, origin, stated_by, created_at, updated_at, done_at`;

async function relatedNumbers(executor: HostSqlExecutor, id: string): Promise<string[]> {
    const rows = await executor.all<{ letter: Letter; n: number }>(
        `SELECT j.letter, j.n FROM intern_related r
         JOIN intern_jobs j ON j.id = CASE WHEN r.job_a = ? THEN r.job_b ELSE r.job_a END
         WHERE r.job_a = ? OR r.job_b = ?
         ORDER BY j.created_at, j.rowid`,
        id,
        id,
        id,
    );
    return rows.map((row) => formatNumber(row.letter, row.n));
}

async function toJob(executor: HostSqlExecutor, row: JobRow): Promise<Job> {
    const job: Job = {
        id: row.id,
        number: formatNumber(row.letter, row.n),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        request: { text: row.request_text, origin: JSON.parse(row.origin) as JobOrigin },
        title: row.title,
        description: row.description,
        definitionOfDone: row.definition_of_done,
        status: row.status,
        related: await relatedNumbers(executor, row.id),
    };
    if (row.done_at !== null) job.doneAt = row.done_at;
    if (row.stated_by !== null) job.statedBy = row.stated_by;
    if (row.blocked_reason !== null) job.blockedReason = row.blocked_reason;
    if (row.resolution_kind !== null) {
        job.resolution = { kind: row.resolution_kind, justification: row.resolution_justification ?? "" };
    }
    return job;
}

async function findRow(executor: HostSqlExecutor, ref: string): Promise<JobRow> {
    const parsed = parseJobRef(ref);
    const row =
        "id" in parsed
            ? await executor.get<JobRow>(`SELECT ${JOB_COLUMNS} FROM intern_jobs WHERE id = ?`, parsed.id)
            : await executor.get<JobRow>(
                  `SELECT ${JOB_COLUMNS} FROM intern_jobs WHERE letter = ? AND n = ?`,
                  parsed.letter,
                  parsed.n,
              );
    if (!row) throw new JobNotFoundError(ref);
    return row;
}

type ListCursor = { createdAt: string; rowid: number };

function encodeCursor(cursor: ListCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(text: string): ListCursor {
    try {
        const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<ListCursor>;
        if (typeof value.createdAt === "string" && Number.isInteger(value.rowid)) return value as ListCursor;
    } catch {
        // Falls through to the error below.
    }
    throw new RangeError("cursor is not one this job store returned");
}

function checkLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new RangeError(`limit must be a whole number from 1 to ${MAX_LIST_LIMIT}`);
    }
    return limit;
}

const RELATED_TO_SQL =
    "EXISTS (SELECT 1 FROM intern_related r " +
    "WHERE (r.job_a = j.id AND r.job_b = ?) OR (r.job_b = j.id AND r.job_a = ?))";

async function listConditions(
    executor: HostSqlExecutor,
    filter: JobListFilter,
): Promise<{ where: string[]; params: HostSqlValue[] }> {
    const where: string[] = [];
    const params: HostSqlValue[] = [];
    if (filter.status !== undefined) {
        where.push("j.status = ?");
        params.push(filter.status);
    }
    if (filter.letter !== undefined) {
        where.push("j.letter = ?");
        params.push(filter.letter);
    }
    if (filter.relatedTo !== undefined) {
        const { id } = await findRow(executor, filter.relatedTo);
        where.push(RELATED_TO_SQL);
        params.push(id, id);
    }
    if (filter.cursor !== undefined) {
        const cursor = decodeCursor(filter.cursor);
        where.push("(j.created_at < ? OR (j.created_at = ? AND j.rowid < ?))");
        params.push(cursor.createdAt, cursor.createdAt, cursor.rowid);
    }
    return { where, params };
}

async function listJobsIn(executor: HostSqlExecutor, filter: JobListFilter): Promise<{ jobs: Job[]; cursor?: string }> {
    const limit = checkLimit(filter.limit);
    const { where, params } = await listConditions(executor, filter);
    const rows = await executor.all<JobRow & { rowid: number }>(
        `SELECT j.rowid AS rowid, ${JOB_COLUMNS} FROM intern_jobs j
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`,
        ...params,
        limit + 1,
    );
    const page = rows.slice(0, limit);
    const jobs: Job[] = [];
    for (const row of page) jobs.push(await toJob(executor, row));
    const last = page[page.length - 1];
    if (rows.length > limit && last) {
        return { jobs, cursor: encodeCursor({ createdAt: last.created_at, rowid: last.rowid }) };
    }
    return { jobs };
}

const NEXT_NUMBER_SQL =
    "INSERT INTO intern_counters (letter, last_value) VALUES (?, 1) " +
    "ON CONFLICT (letter) DO UPDATE SET last_value = last_value + 1";

async function allocateNumber(tx: HostSqlExecutor, letter: Letter): Promise<number> {
    await tx.run(NEXT_NUMBER_SQL, letter);
    const row = await tx.get<{ last_value: number }>("SELECT last_value FROM intern_counters WHERE letter = ?", letter);
    if (!row) throw new Error(`the counter for letter ${letter} was not written`);
    return row.last_value;
}

async function insertIn(tx: HostSqlExecutor, input: NewJob): Promise<{ job: Job; created: boolean }> {
    if (input.idempotencyKey !== undefined) {
        const existing = await tx.get<JobRow>(
            `SELECT ${JOB_COLUMNS} FROM intern_jobs WHERE idempotency_key = ?`,
            input.idempotencyKey,
        );
        if (existing) return { job: await toJob(tx, existing), created: false };
    }
    const n = await allocateNumber(tx, input.letter);
    const id = randomUUID();
    const now = new Date().toISOString();
    await tx.run(
        `INSERT INTO intern_jobs (id, letter, n, title, description, definition_of_done, status, request_text, origin,
            stated_by, lead_start, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '', 'to_do', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.letter,
        n,
        input.title ?? "",
        input.requestText,
        JSON.stringify(input.origin),
        input.statedBy ?? null,
        JSON.stringify(input.leadStart ?? null),
        input.idempotencyKey ?? null,
        now,
        now,
    );
    return { job: await toJob(tx, await findRow(tx, id)), created: true };
}

export function createJobStore(db: HostDatabase, options: JobStoreOptions = {}): JobStore {
    const listeners = new Set<(change: JobChange) => void>();

    const report = (change: JobChange): void => {
        for (const listener of [...listeners]) {
            try {
                listener(change);
            } catch (error) {
                if (options.onListenerError) options.onListenerError(error);
                else process.emitWarning(`A job store listener threw: ${String(error)}`);
            }
        }
    };

    return {
        async insertJob(input) {
            const result = await db.transaction((tx) => insertIn(tx, input));
            if (result.created) report({ type: "job_created", job: result.job });
            return result;
        },
        async getJob(ref) {
            return toJob(db, await findRow(db, ref));
        },
        listJobs: (filter) => listJobsIn(db, filter),
        async leadStartOf(ref) {
            const { id } = await findRow(db, ref);
            const row = await db.get<{ lead_start: string }>("SELECT lead_start FROM intern_jobs WHERE id = ?", id);
            return JSON.parse(row?.lead_start ?? "null");
        },
        onCommit(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
