// The saved history of schedule entries (S-007 REQ-006, REQ-009, REQ-016): the skipped fires and the run history
// queries. It works on the job store's executor and imports no pi package. The job store passes in what it owns: the
// checked limit and the reader that turns a job's id into a `Job`.

import type { HostSqlExecutor, HostSqlValue } from "../host/harness_host.ts";
import type { Job } from "./job_store.ts";

/** A fire that created no job. `dueAt` is UTC, `dueTime` the local text, `openRun` the open scheduled run's number. */
export type ScheduleSkip = {
    entry: string;
    dueAt: string;
    dueTime: string;
    reason: string;
    openRun: string | null;
};

export type ScheduleRunItem = { kind: "run"; firedAt: string; job: Job } | { kind: "skip"; skip: ScheduleSkip };

type ItemKind = ScheduleRunItem["kind"];

// A run sorts before a skip at the same time, so the run's rank is the lower one.
const RANK: Record<ItemKind, number> = { run: 0, skip: 1 };

type HistoryCursor = { at: string; kind: ItemKind; rowid: number };

function encodeCursor(cursor: HistoryCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(text: string): HistoryCursor {
    try {
        const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<HistoryCursor>;
        if (
            typeof value.at === "string" &&
            (value.kind === "run" || value.kind === "skip") &&
            Number.isInteger(value.rowid)
        ) {
            return value as HistoryCursor;
        }
    } catch {
        // Falls through to the error below.
    }
    throw new RangeError("cursor is not one this job store returned");
}

/** Whether the source of `kind` can still hold an item after the cursor, and so the condition that selects them. */
function afterCursor(
    kind: ItemKind,
    timeColumn: string,
    cursor: HistoryCursor,
): { sql: string; params: HostSqlValue[] } {
    if (RANK[kind] > RANK[cursor.kind]) return { sql: `${timeColumn} <= ?`, params: [cursor.at] };
    if (RANK[kind] < RANK[cursor.kind]) return { sql: `${timeColumn} < ?`, params: [cursor.at] };
    return {
        sql: `(${timeColumn} < ? OR (${timeColumn} = ? AND rowid < ?))`,
        params: [cursor.at, cursor.at, cursor.rowid],
    };
}

type SkipRow = {
    rowid: number;
    entry: string;
    due_at: string;
    due_time: string;
    reason: string;
    open_run: string | null;
};

type Candidate = { at: string; kind: ItemKind; rowid: number; item: () => Promise<ScheduleRunItem> };

/** Writes the skip and reports whether it did. A row for the same entry and due time is left as it is. */
export async function insertSkip(tx: HostSqlExecutor, skip: ScheduleSkip): Promise<boolean> {
    const existing = await tx.get<{ entry: string }>(
        "SELECT entry FROM intern_schedule_skips WHERE entry = ? AND due_at = ?",
        skip.entry,
        skip.dueAt,
    );
    if (existing) return false;
    await tx.run(
        "INSERT INTO intern_schedule_skips (entry, due_at, due_time, reason, open_run) VALUES (?, ?, ?, ?, ?)",
        skip.entry,
        skip.dueAt,
        skip.dueTime,
        skip.reason,
        skip.openRun,
    );
    return true;
}

/**
 * The newest `limit + 1` of the entry's jobs and of its skips, each read from its index and merged newest first.
 * `limit` is already checked by the caller.
 */
export async function readScheduleRuns(
    executor: HostSqlExecutor,
    entry: string,
    page: { limit: number; cursor?: string },
    readJob: (id: string) => Promise<Job>,
): Promise<{ items: ScheduleRunItem[]; cursor?: string }> {
    const cursor = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const jobCondition = cursor ? afterCursor("run", "schedule_fired_at", cursor) : undefined;
    const skipCondition = cursor ? afterCursor("skip", "due_at", cursor) : undefined;
    const jobs = await executor.all<{ rowid: number; id: string; schedule_fired_at: string }>(
        `SELECT rowid, id, schedule_fired_at FROM intern_jobs WHERE schedule_entry = ?
         ${jobCondition ? `AND ${jobCondition.sql}` : ""}
         ORDER BY schedule_fired_at DESC, rowid DESC LIMIT ?`,
        entry,
        ...(jobCondition?.params ?? []),
        page.limit + 1,
    );
    const skips = await executor.all<SkipRow>(
        `SELECT rowid, entry, due_at, due_time, reason, open_run FROM intern_schedule_skips WHERE entry = ?
         ${skipCondition ? `AND ${skipCondition.sql}` : ""}
         ORDER BY due_at DESC, rowid DESC LIMIT ?`,
        entry,
        ...(skipCondition?.params ?? []),
        page.limit + 1,
    );
    const candidates: Candidate[] = [
        ...jobs.map(
            (row): Candidate => ({
                at: row.schedule_fired_at,
                kind: "run",
                rowid: row.rowid,
                item: async () => ({ kind: "run", firedAt: row.schedule_fired_at, job: await readJob(row.id) }),
            }),
        ),
        ...skips.map(
            (row): Candidate => ({
                at: row.due_at,
                kind: "skip",
                rowid: row.rowid,
                item: async () => ({
                    kind: "skip",
                    skip: {
                        entry: row.entry,
                        dueAt: row.due_at,
                        dueTime: row.due_time,
                        reason: row.reason,
                        openRun: row.open_run,
                    },
                }),
            }),
        ),
    ];
    candidates.sort(
        (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || RANK[a.kind] - RANK[b.kind] || b.rowid - a.rowid,
    );
    const shown = candidates.slice(0, page.limit);
    const items: ScheduleRunItem[] = [];
    for (const candidate of shown) items.push(await candidate.item());
    const last = shown[shown.length - 1];
    if (candidates.length > page.limit && last) {
        return { items, cursor: encodeCursor({ at: last.at, kind: last.kind, rowid: last.rowid }) };
    }
    return { items };
}

/** The id of the entry's newest job, or undefined when it has none. */
export async function newestJobId(executor: HostSqlExecutor, entry: string): Promise<string | undefined> {
    const row = await executor.get<{ id: string }>(
        "SELECT id FROM intern_jobs WHERE schedule_entry = ? ORDER BY schedule_fired_at DESC, rowid DESC LIMIT 1",
        entry,
    );
    return row?.id;
}
