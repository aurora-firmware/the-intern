// The job store (S-004 REQ-001, REQ-002, REQ-014; ADR-001 decision 1): the job record in the-intern's own `intern_`
// tables in the instance's SQLite file. It uses only `HostDatabase`, so it imports no pi package, and it never
// touches pi-durable's tables. The job schema version lives in `intern_schema`, never in the file's `user_version`.

import { randomUUID } from "node:crypto";
import type { HostDatabase, HostSqlExecutor, HostSqlValue } from "../host/harness_host.ts";
import {
    type ActionInput,
    checkAction,
    checkEdit,
    type EditableField,
    formatNumber,
    type JobAction,
    type JobAuthor,
    type JobOrigin,
    type JobStatus,
    type Letter,
    parseJobRef,
    type Resolution,
} from "./job_model.ts";

export const JOB_SCHEMA_VERSION = 2;

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

/** A refused write: `conflict` for a status that doesn't allow it, `invalid_input` for a bad value. Nothing changed. */
export class JobRefusedError extends Error {
    readonly code: "conflict" | "invalid_input";
    readonly field?: string;

    constructor(code: "conflict" | "invalid_input", message: string, field?: string) {
        super(message);
        this.name = "JobRefusedError";
        this.code = code;
        if (field !== undefined) this.field = field;
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
    /** A job to relate the new one to, written in the insert's own transaction. */
    relatedTo?: string;
    /** Who authors that Related link in the history. The daemon when omitted. */
    author?: JobAuthor;
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

export type WorklogEntry = { at: string; author: JobAuthor; text: string };
export type HistoryEntry = { at: string; author: JobAuthor; field: string; old: unknown; new: unknown };
export type EntryPage = { limit?: number; cursor?: string };

export type JobChange =
    | { type: "job_created"; job: Job }
    | { type: "job_changed"; number: string; fields: Partial<Record<EditableField, string>> }
    | { type: "worklog_added"; number: string; entry: WorklogEntry }
    | { type: "status_changed"; number: string; old: JobStatus; new: JobStatus; blockedReason?: string }
    | { type: "job_done"; number: string; resolution: Resolution }
    | { type: "related_changed"; numbers: [string, string] };

export type JobStore = {
    insertJob(input: NewJob): Promise<{ job: Job; created: boolean }>;
    getJob(ref: string): Promise<Job>;
    listJobs(filter: JobListFilter): Promise<{ jobs: Job[]; cursor?: string }>;
    leadStartOf(ref: string): Promise<unknown>;
    /** The lead's newest transcript entry ID recorded by the job's block, or null (S-004 REQ-018 rule 3). */
    blockedAfterEntryOf(ref: string): Promise<string | null>;
    updateFields(ref: string, fields: Partial<Record<EditableField, string>>, author: JobAuthor): Promise<Job>;
    addWorklog(ref: string, text: string, author: JobAuthor): Promise<WorklogEntry>;
    listWorklog(ref: string, page: EntryPage): Promise<{ entries: WorklogEntry[]; cursor?: string }>;
    listHistory(ref: string, page: EntryPage): Promise<{ entries: HistoryEntry[]; cursor?: string }>;
    relate(a: string, b: string, author: JobAuthor): Promise<{ a: Job; b: Job }>;
    unrelate(a: string, b: string, author: JobAuthor): Promise<{ a: Job; b: Job }>;
    applyAction(ref: string, action: JobAction, input: ActionInput, author: JobAuthor): Promise<Job>;
    /** Appends one `repair` history entry by the daemon. Reports no change. */
    recordRepair(ref: string, repair: { rule: 1 | 2 | 3 | 4; did: string }): Promise<void>;
    /** Reports each change after its transaction commits. Returns the function that removes the listener. */
    onCommit(listener: (change: JobChange) => void): () => void;
};

export type JobStoreOptions = {
    /** Called when a commit listener throws. The write has committed and stays committed. */
    onListenerError?: (error: unknown) => void;
    /**
     * Called once when a write's transaction fails with anything but a refusal or an unknown job. The transaction has
     * rolled back and the write rejects with the same error (S-004 REQ-020, ADR-001 decision 5).
     */
    onWriteFailure?: (error: unknown) => void;
};

export const JOB_MIGRATIONS: readonly string[] = [
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
    "ALTER TABLE intern_jobs ADD COLUMN blocked_after_entry TEXT;",
];

if (JOB_MIGRATIONS.length !== JOB_SCHEMA_VERSION) throw new Error("JOB_SCHEMA_VERSION and MIGRATIONS are out of step");

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
            await tx.exec(JOB_MIGRATIONS[next - 1] as string);
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

type Inserted = { job: Job; created: boolean; changes: JobChange[] };

async function insertIn(tx: HostSqlExecutor, input: NewJob): Promise<Inserted> {
    if (input.idempotencyKey !== undefined) {
        const existing = await tx.get<JobRow>(
            `SELECT ${JOB_COLUMNS} FROM intern_jobs WHERE idempotency_key = ?`,
            input.idempotencyKey,
        );
        if (existing) return { job: await toJob(tx, existing), created: false, changes: [] };
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
    const changes: JobChange[] = [];
    if (input.relatedTo !== undefined) {
        const other = await findRow(tx, input.relatedTo);
        const linked = await setLinkIn(tx, await findRow(tx, id), other, true, input.author ?? DAEMON, now);
        if (linked) changes.push(linked);
    }
    const job = await toJob(tx, await findRow(tx, id));
    return { job, created: true, changes: [{ type: "job_created", job }, ...changes] };
}

const DAEMON: JobAuthor = { kind: "daemon" };

async function addHistory(tx: HostSqlExecutor, jobId: string, entry: HistoryEntry): Promise<void> {
    await tx.run(
        `INSERT INTO intern_history (job, sequence, at, author, field, old_value, new_value)
         VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM intern_history WHERE job = ?), ?, ?, ?, ?, ?)`,
        jobId,
        jobId,
        entry.at,
        JSON.stringify(entry.author),
        entry.field,
        JSON.stringify(entry.old ?? null),
        JSON.stringify(entry.new ?? null),
    );
}

function refuse(check: { code: "conflict" | "invalid_input"; field?: string; message: string }): never {
    throw new JobRefusedError(check.code, check.message, check.field);
}

const FIELD_COLUMNS: Readonly<Record<EditableField, string>> = {
    title: "title",
    description: "description",
    definitionOfDone: "definition_of_done",
};

const STORED_VALUES: Readonly<Record<EditableField, (row: JobRow) => string>> = {
    title: (row) => row.title,
    description: (row) => row.description,
    definitionOfDone: (row) => row.definition_of_done,
};

/** What a write returns, and the changes to report once its transaction has committed. */
type Written<T> = { value: T; changes: JobChange[] };

async function updateFieldsIn(
    tx: HostSqlExecutor,
    ref: string,
    fields: Partial<Record<EditableField, string>>,
    author: JobAuthor,
): Promise<Written<Job>> {
    const row = await findRow(tx, ref);
    const check = checkEdit(row.status, Object.keys(fields));
    if (!check.ok) refuse(check);
    const at = new Date().toISOString();
    const changed: Partial<Record<EditableField, string>> = {};
    for (const name of Object.keys(fields) as EditableField[]) {
        const next = fields[name];
        const old = STORED_VALUES[name](row);
        if (next === undefined || next === old) continue;
        await tx.run(`UPDATE intern_jobs SET ${FIELD_COLUMNS[name]} = ? WHERE id = ?`, next, row.id);
        await addHistory(tx, row.id, { at, author, field: name, old, new: next });
        changed[name] = next;
    }
    if (Object.keys(changed).length === 0) return { value: await toJob(tx, row), changes: [] };
    await tx.run("UPDATE intern_jobs SET updated_at = ? WHERE id = ?", at, row.id);
    const job = await toJob(tx, await findRow(tx, row.id));
    return { value: job, changes: [{ type: "job_changed", number: job.number, fields: changed }] };
}

async function addWorklogIn(
    tx: HostSqlExecutor,
    ref: string,
    text: string,
    author: JobAuthor,
): Promise<Written<WorklogEntry>> {
    const row = await findRow(tx, ref);
    if (row.status === "done") {
        refuse({ code: "conflict", message: "worklog refused: the job is Done and Done is final" });
    }
    if (text.trim() === "") refuse({ code: "invalid_input", field: "text", message: "a worklog entry needs text" });
    const entry: WorklogEntry = { at: new Date().toISOString(), author, text };
    await tx.run(
        `INSERT INTO intern_worklog (job, sequence, at, author, text)
         VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM intern_worklog WHERE job = ?), ?, ?, ?)`,
        row.id,
        row.id,
        entry.at,
        JSON.stringify(author),
        text,
    );
    return { value: entry, changes: [{ type: "worklog_added", number: formatNumber(row.letter, row.n), entry }] };
}

function decodeSequenceCursor(text: string): number {
    try {
        const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as { after?: unknown };
        if (typeof value.after === "number" && Number.isInteger(value.after)) return value.after;
    } catch {
        // Falls through to the error below.
    }
    throw new RangeError("cursor is not one this job store returned");
}

async function listEntries<Row extends { sequence: number }, Entry>(
    executor: HostSqlExecutor,
    table: "intern_worklog" | "intern_history",
    columns: string,
    ref: string,
    page: EntryPage,
    toEntry: (row: Row) => Entry,
): Promise<{ entries: Entry[]; cursor?: string }> {
    const limit = checkLimit(page.limit);
    const after = page.cursor === undefined ? 0 : decodeSequenceCursor(page.cursor);
    const { id } = await findRow(executor, ref);
    const rows = await executor.all<Row>(
        `SELECT sequence, ${columns} FROM ${table} WHERE job = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        id,
        after,
        limit + 1,
    );
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    const entries = shown.map(toEntry);
    if (rows.length > limit && last) {
        return { entries, cursor: Buffer.from(JSON.stringify({ after: last.sequence })).toString("base64url") };
    }
    return { entries };
}

type WorklogRow = { sequence: number; at: string; author: string; text: string };
type HistoryRow = { sequence: number; at: string; author: string; field: string; old_value: string; new_value: string };

const toWorklogEntry = (row: WorklogRow): WorklogEntry => ({
    at: row.at,
    author: JSON.parse(row.author) as JobAuthor,
    text: row.text,
});

const toHistoryEntry = (row: HistoryRow): HistoryEntry => ({
    at: row.at,
    author: JSON.parse(row.author) as JobAuthor,
    field: row.field,
    old: JSON.parse(row.old_value),
    new: JSON.parse(row.new_value),
});

const orderedPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** Adds or removes the link and writes both jobs' history. Returns the change, or undefined when nothing changed. */
async function setLinkIn(
    tx: HostSqlExecutor,
    a: JobRow,
    b: JobRow,
    isLinking: boolean,
    author: JobAuthor,
    at: string,
): Promise<JobChange | undefined> {
    if (a.id === b.id) {
        refuse({ code: "invalid_input", field: "jobs", message: "a job can't be related to itself" });
    }
    const [low, high] = orderedPair(a.id, b.id);
    const existing = await tx.get<{ job_a: string }>(
        "SELECT job_a FROM intern_related WHERE job_a = ? AND job_b = ?",
        low,
        high,
    );
    if ((existing !== undefined) === isLinking) return undefined;
    if (isLinking) await tx.run("INSERT INTO intern_related (job_a, job_b) VALUES (?, ?)", low, high);
    else await tx.run("DELETE FROM intern_related WHERE job_a = ? AND job_b = ?", low, high);
    const numberA = formatNumber(a.letter, a.n);
    const numberB = formatNumber(b.letter, b.n);
    const entryFor = (other: string): HistoryEntry => ({
        at,
        author,
        field: "related",
        old: isLinking ? null : other,
        new: isLinking ? other : null,
    });
    await addHistory(tx, a.id, entryFor(numberB));
    await addHistory(tx, b.id, entryFor(numberA));
    await tx.run("UPDATE intern_jobs SET updated_at = ? WHERE id IN (?, ?)", at, a.id, b.id);
    return { type: "related_changed", numbers: [numberA, numberB] };
}

async function setLinkByRef(
    tx: HostSqlExecutor,
    refA: string,
    refB: string,
    isLinking: boolean,
    author: JobAuthor,
): Promise<Written<{ a: Job; b: Job }>> {
    const rowA = await findRow(tx, refA);
    const rowB = await findRow(tx, refB);
    const change = await setLinkIn(tx, rowA, rowB, isLinking, author, new Date().toISOString());
    const a = await toJob(tx, await findRow(tx, rowA.id));
    const b = await toJob(tx, await findRow(tx, rowB.id));
    return { value: { a, b }, changes: change ? [change] : [] };
}

const ACTION_RESOLUTIONS: Readonly<Partial<Record<JobAction, Resolution["kind"]>>> = {
    complete: "completed",
    cancel: "cancelled",
};

async function applyActionIn(
    tx: HostSqlExecutor,
    ref: string,
    action: JobAction,
    input: ActionInput,
    author: JobAuthor,
): Promise<Written<Job>> {
    const row = await findRow(tx, ref);
    // The definition of done is a stored field, so a complete that doesn't pass one is judged on the stored one.
    const check = checkAction(row.status, action, {
        ...input,
        definitionOfDone: input.definitionOfDone ?? row.definition_of_done,
    });
    if (!check.ok) refuse(check);
    const at = new Date().toISOString();
    const number = formatNumber(row.letter, row.n);
    await tx.run("UPDATE intern_jobs SET status = ?, updated_at = ? WHERE id = ?", check.to, at, row.id);
    await addHistory(tx, row.id, { at, author, field: "status", old: row.status, new: check.to });
    const reason = action === "block" ? (input.blockedReason as string) : null;
    if (reason !== row.blocked_reason) {
        await tx.run("UPDATE intern_jobs SET blocked_reason = ? WHERE id = ?", reason, row.id);
        await addHistory(tx, row.id, { at, author, field: "blockedReason", old: row.blocked_reason, new: reason });
    }
    // Neither a history entry nor a change: the entry is the daemon's own record for rule 3 (S-004 Interfaces).
    if (action === "block" || action === "resume") {
        const entry = action === "block" ? (input.blockedAfterEntry ?? null) : null;
        await tx.run("UPDATE intern_jobs SET blocked_after_entry = ? WHERE id = ?", entry, row.id);
    }
    const kind = ACTION_RESOLUTIONS[action];
    let change: JobChange;
    if (kind === undefined) {
        change = { type: "status_changed", number, old: row.status, new: check.to };
        if (reason !== null) change.blockedReason = reason;
    } else {
        const resolution: Resolution = { kind, justification: input.justification as string };
        await tx.run(
            "UPDATE intern_jobs SET resolution_kind = ?, resolution_justification = ?, done_at = ? WHERE id = ?",
            kind,
            resolution.justification,
            at,
            row.id,
        );
        await addHistory(tx, row.id, { at, author, field: "resolution", old: null, new: resolution });
        change = { type: "job_done", number, resolution };
    }
    return { value: await toJob(tx, await findRow(tx, row.id)), changes: [change] };
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

    // A refusal or an unknown job is the caller's mistake and changes nothing; any other failure is a storage error.
    const transact = async <T>(body: (tx: HostSqlExecutor) => Promise<T>): Promise<T> => {
        try {
            return await db.transaction(body);
        } catch (error) {
            if (!(error instanceof JobRefusedError || error instanceof JobNotFoundError))
                options.onWriteFailure?.(error);
            throw error;
        }
    };

    const write = async <T>(body: (tx: HostSqlExecutor) => Promise<Written<T>>): Promise<T> => {
        const { value, changes } = await transact(body);
        for (const change of changes) report(change);
        return value;
    };

    return {
        async insertJob(input) {
            const { job, created, changes } = await transact((tx) => insertIn(tx, input));
            for (const change of changes) report(change);
            return { job, created };
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
        async blockedAfterEntryOf(ref) {
            const { id } = await findRow(db, ref);
            const row = await db.get<{ blocked_after_entry: string | null }>(
                "SELECT blocked_after_entry FROM intern_jobs WHERE id = ?",
                id,
            );
            return row?.blocked_after_entry ?? null;
        },
        updateFields: (ref, fields, author) => write((tx) => updateFieldsIn(tx, ref, fields, author)),
        addWorklog: (ref, text, author) => write((tx) => addWorklogIn(tx, ref, text, author)),
        listWorklog: (ref, page) =>
            listEntries<WorklogRow, WorklogEntry>(db, "intern_worklog", "at, author, text", ref, page, toWorklogEntry),
        listHistory: (ref, page) =>
            listEntries<HistoryRow, HistoryEntry>(
                db,
                "intern_history",
                "at, author, field, old_value, new_value",
                ref,
                page,
                toHistoryEntry,
            ),
        relate: (a, b, author) => write((tx) => setLinkByRef(tx, a, b, true, author)),
        unrelate: (a, b, author) => write((tx) => setLinkByRef(tx, a, b, false, author)),
        applyAction: (ref, action, input, author) => write((tx) => applyActionIn(tx, ref, action, input, author)),
        async recordRepair(ref, repair) {
            await transact(async (tx) => {
                const { id } = await findRow(tx, ref);
                const at = new Date().toISOString();
                await addHistory(tx, id, { at, author: DAEMON, field: "repair", old: null, new: repair });
            });
        },
        onCommit(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
