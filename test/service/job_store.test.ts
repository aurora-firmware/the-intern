import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import {
    checkJobSchemaVersion,
    createJobStore,
    JOB_MIGRATIONS,
    JOB_SCHEMA_VERSION,
    type JobChange,
    JobNotFoundError,
    JobRefusedError,
    JobSchemaTooNewError,
    migrateJobStore,
    type NewJob,
    readJobSchemaVersion,
} from "../../src/jobs/job_store.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type Db = Awaited<ReturnType<typeof openHostDatabase>>;

const envs: HermeticEnv[] = [];
const databases: Db[] = [];

afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
    for (const env of envs.splice(0)) await env.dispose();
});

async function openDb(): Promise<Db> {
    const env = await createHermeticEnv();
    envs.push(env);
    const db = await openHostDatabase(join(env.dataDir, "bob.sqlite"));
    databases.push(db);
    return db;
}

async function openMigrated() {
    const db = await openDb();
    await migrateJobStore(db);
    return { db, store: createJobStore(db) };
}

const newJob = (letter: NewJob["letter"], extra: Partial<NewJob> = {}): NewJob => ({
    letter,
    requestText: `request ${letter}`,
    origin: { kind: "request", wayIn: "command line" },
    leadStart: { role: "lead" },
    ...extra,
});

const numbersOf = (jobs: { number: string }[]): string[] => jobs.map((job) => job.number);

describe("job store schema", () => {
    it("creates the tables at the current version and changes nothing when run again", async () => {
        const db = await openDb();
        assert.equal(await readJobSchemaVersion(db), 0);
        await migrateJobStore(db);
        assert.equal(await readJobSchemaVersion(db), JOB_SCHEMA_VERSION);
        const tables = async () =>
            (await db.all<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name")).map((r) => r.name);
        const before = await tables();
        for (const name of ["schema", "jobs", "counters", "worklog", "history", "related"]) {
            assert.ok(before.includes(`intern_${name}`), name);
        }
        await migrateJobStore(db);
        assert.deepEqual(await tables(), before);
        assert.equal(await readJobSchemaVersion(db), JOB_SCHEMA_VERSION);
        assert.equal((await db.get<{ user_version: number }>("PRAGMA user_version"))?.user_version, 0);
    });

    it("refuses a newer version, naming both, and writes nothing", async () => {
        const db = await openDb();
        await migrateJobStore(db);
        await db.run("UPDATE intern_schema SET version = ?", JOB_SCHEMA_VERSION + 1);
        await assert.rejects(checkJobSchemaVersion(db), (error: Error) => {
            assert.ok(error instanceof JobSchemaTooNewError);
            assert.match(error.message, new RegExp(`version ${JOB_SCHEMA_VERSION + 1}\\b`));
            assert.match(error.message, new RegExp(`version ${JOB_SCHEMA_VERSION}\\b`));
            return true;
        });
        await assert.rejects(migrateJobStore(db), JobSchemaTooNewError);
        assert.equal(await readJobSchemaVersion(db), JOB_SCHEMA_VERSION + 1);
    });
});

describe("job store migration 2", () => {
    it("brings a version 1 file to version 2 with blockedAfterEntry null and other columns unchanged", async () => {
        const db = await openDb();
        await db.exec(JOB_MIGRATIONS[0] as string);
        await db.run("INSERT INTO intern_schema (id, version) VALUES (1, 1)");
        const insert =
            "INSERT INTO intern_jobs (id, letter, n, title, description, definition_of_done, status, blocked_reason, " +
            "request_text, origin, lead_start, created_at, updated_at) VALUES (?, 'C', ?, 't', 'd', 'x', ?, ?, 'r', " +
            "'{}', '{}', 'c', 'u')";
        await db.run(insert, "id-1", 1, "blocked", "waiting");
        await db.run(insert, "id-2", 2, "to_do", null);
        const before = (await db.all("SELECT * FROM intern_jobs ORDER BY id")).map((row) => ({ ...row }));
        assert.equal(await readJobSchemaVersion(db), 1);

        await migrateJobStore(db);

        assert.equal(await readJobSchemaVersion(db), 2);
        const after = await db.all<Record<string, unknown>>("SELECT * FROM intern_jobs ORDER BY id");
        assert.deepEqual(
            after.map((row) => row.blocked_after_entry),
            [null, null],
        );
        assert.deepEqual(
            after.map(({ blocked_after_entry: _column, ...rest }) => ({ ...rest })),
            before,
        );
        assert.equal(await createJobStore(db).blockedAfterEntryOf("id-1"), null);
    });
});

describe("job store inserts", () => {
    it("numbers jobs per letter and uses no number for a repeated idempotency key", async () => {
        const { store } = await openMigrated();
        const seen: string[] = [];
        store.onCommit((change) => change.type === "job_created" && seen.push(change.job.number));
        const made = [];
        for (const letter of ["C", "C", "E"] as const) made.push((await store.insertJob(newJob(letter))).job);
        const first = await store.insertJob(newJob("C", { idempotencyKey: "k1", leadStart: { role: "x", n: 1 } }));
        const again = await store.insertJob(newJob("C", { idempotencyKey: "k1", leadStart: { role: "other" } }));
        const next = await store.insertJob(newJob("C"));
        assert.equal(first.created, true);
        assert.equal(again.created, false);
        assert.equal(again.job.id, first.job.id);
        assert.deepEqual(numbersOf([...made, first.job, next.job]), ["C-1", "C-2", "E-1", "C-3", "C-4"]);
        assert.deepEqual(seen, ["C-1", "C-2", "E-1", "C-3", "C-4"]);
        assert.deepEqual(await store.leadStartOf("c-3"), { role: "x", n: 1 });
        assert.equal(first.job.status, "to_do");
    });

    it("reports nothing when the write is rolled back", async () => {
        const { db, store } = await openMigrated();
        const seen: unknown[] = [];
        store.onCommit((change) => seen.push(change));
        await db.exec("DROP TABLE intern_counters");
        await assert.rejects(store.insertJob(newJob("C")));
        assert.deepEqual(seen, []);
    });
});

describe("job store reads", () => {
    it("finds a job by ID or by short number in any case", async () => {
        const { store } = await openMigrated();
        let target = (await store.insertJob(newJob("E"))).job;
        for (let i = 0; i < 13; i++) target = (await store.insertJob(newJob("E"))).job;
        assert.equal(target.number, "E-14");
        for (const ref of ["e-14", "E-14", target.id]) assert.deepEqual(await store.getJob(ref), target);
        await assert.rejects(store.getJob("E-99"), JobNotFoundError);
        await assert.rejects(store.getJob("no-such-id"), JobNotFoundError);
    });

    it("lists newest first in pages filtered by status and letter", async () => {
        const { db, store } = await openMigrated();
        const made = [];
        for (const letter of ["C", "E", "C", "C", "C", "C"] as const) {
            made.push((await store.insertJob(newJob(letter))).job);
        }
        for (const index of [0, 1, 3, 4]) {
            await db.run("UPDATE intern_jobs SET status = 'in_progress' WHERE id = ?", made[index]?.id as string);
        }
        const filter = { status: "in_progress", letter: "C", limit: 2 } as const;
        const page1 = await store.listJobs(filter);
        assert.deepEqual(numbersOf(page1.jobs), ["C-4", "C-3"]);
        assert.ok(page1.cursor);
        const page2 = await store.listJobs({ ...filter, cursor: page1.cursor });
        assert.deepEqual(numbersOf(page2.jobs), ["C-1"]);
        assert.equal(page2.cursor, undefined);
        const all = await store.listJobs({});
        assert.deepEqual(numbersOf(all.jobs), ["C-5", "C-4", "C-3", "C-2", "E-1", "C-1"]);
        assert.equal(all.cursor, undefined);
        await assert.rejects(store.listJobs({ limit: 501 }), RangeError);
    });

    it("filters by Related job", async () => {
        const { db, store } = await openMigrated();
        const a = (await store.insertJob(newJob("C"))).job;
        const b = (await store.insertJob(newJob("E"))).job;
        await store.insertJob(newJob("W"));
        const [low, high] = [a.id, b.id].sort() as [string, string];
        await db.run("INSERT INTO intern_related (job_a, job_b) VALUES (?, ?)", low, high);
        assert.deepEqual(numbersOf((await store.listJobs({ relatedTo: "c-1" })).jobs), ["E-1"]);
        assert.deepEqual((await store.getJob(a.id)).related, ["E-1"]);
    });
});

const lead = { kind: "agent", conversationId: "conv-1", role: "lead" } as const;
const member = { kind: "team_member", wayIn: "command line" } as const;
const daemon = { kind: "daemon" } as const;

async function openWithJob(extra: Partial<NewJob> = {}) {
    const { db, store } = await openMigrated();
    const changes: JobChange[] = [];
    const job = (await store.insertJob(newJob("C", extra))).job;
    store.onCommit((change) => changes.push(change));
    return { db, store, job, changes };
}

const refusal = (code: "conflict" | "invalid_input", field?: string) => (error: unknown) => {
    assert.ok(error instanceof JobRefusedError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.field, field);
    return true;
};

describe("blockedAfterEntry", () => {
    it("is set by a block, cleared by a resume, and kept by other actions", async () => {
        const { store, job } = await openWithJob();
        assert.equal(await store.blockedAfterEntryOf(job.number), null);
        await store.applyAction(job.number, "start", {}, daemon);
        assert.equal(await store.blockedAfterEntryOf(job.number), null);
        await store.applyAction(job.number, "block", { blockedReason: "need a key", blockedAfterEntry: "17" }, lead);
        assert.equal(await store.blockedAfterEntryOf(job.id), "17");
        await store.applyAction(job.number, "resume", {}, daemon);
        assert.equal(await store.blockedAfterEntryOf(job.number), null);
        await store.applyAction(job.number, "block", { blockedReason: "again" }, lead);
        assert.equal(await store.blockedAfterEntryOf(job.number), null);
    });

    it("is not in the job, the history or the changes", async () => {
        const plain = await openWithJob();
        const recorded = await openWithJob();
        const run = async (w: typeof plain, extra: { blockedAfterEntry?: string }) => {
            await w.store.applyAction(w.job.number, "start", {}, daemon);
            const blocked = await w.store.applyAction(w.job.number, "block", { blockedReason: "r", ...extra }, lead);
            const resumed = await w.store.applyAction(w.job.number, "resume", {}, daemon);
            return { blocked, resumed, history: (await w.store.listHistory(w.job.number, {})).entries };
        };
        const a = await run(plain, {});
        const b = await run(recorded, { blockedAfterEntry: "9" });
        const strip = (v: typeof a) => JSON.stringify([v.blocked, v.resumed, v.history.map(({ at: _at, ...r }) => r)]);
        const text = JSON.stringify(b);
        assert.ok(!text.includes("blockedAfterEntry") && !text.includes("blocked_after_entry"));
        assert.equal(
            strip(b).replace(/"(createdAt|updatedAt|id|number)":"[^"]*"/g, ""),
            strip(a).replace(/"(createdAt|updatedAt|id|number)":"[^"]*"/g, ""),
        );
        assert.deepEqual(
            recorded.changes.map((c) => c.type),
            plain.changes.map((c) => c.type),
        );
        assert.ok(!JSON.stringify(recorded.changes).includes('9"'));
    });
});

describe("job store writes and history", () => {
    it("holds exactly the changes of an edited, blocked, resumed and completed job", async () => {
        const { store, job } = await openWithJob();
        await store.updateFields(job.number, { title: "First" }, member);
        await store.updateFields(job.number, { title: "Second", definitionOfDone: "tests pass" }, lead);
        await store.applyAction(job.number, "start", {}, daemon);
        await store.applyAction(job.number, "block", { blockedReason: "need a key" }, lead);
        await store.applyAction(job.number, "resume", {}, daemon);
        const done = await store.applyAction(job.number, "complete", { justification: "all green" }, lead);
        assert.equal(done.title, "Second");
        assert.equal(done.status, "done");
        assert.equal(done.blockedReason, undefined);
        assert.deepEqual(done.resolution, { kind: "completed", justification: "all green" });
        assert.ok(done.doneAt);
        const { entries } = await store.listHistory(job.number, {});
        const shape = entries.map((e) => [e.field, e.old, e.new, e.author.kind]);
        assert.deepEqual(shape, [
            ["title", "", "First", "team_member"],
            ["title", "First", "Second", "agent"],
            ["definitionOfDone", "", "tests pass", "agent"],
            ["status", "to_do", "in_progress", "daemon"],
            ["status", "in_progress", "blocked", "agent"],
            ["blockedReason", null, "need a key", "agent"],
            ["status", "blocked", "in_progress", "daemon"],
            ["blockedReason", "need a key", null, "daemon"],
            ["status", "in_progress", "done", "agent"],
            ["resolution", null, { kind: "completed", justification: "all green" }, "agent"],
        ]);
        for (const entry of entries) assert.ok(entry.at);
    });

    it("refuses fields that aren't editable and changes nothing", async () => {
        const { store, job, changes } = await openWithJob();
        for (const name of ["number", "status", "resolution", "blockedReason", "request", "createdAt"]) {
            await assert.rejects(
                store.updateFields(job.number, { title: "x", [name]: "y" }, member),
                refusal("invalid_input", name),
            );
        }
        assert.deepEqual(await store.getJob(job.number), job);
        assert.deepEqual((await store.listHistory(job.number, {})).entries, []);
        assert.deepEqual(changes, []);
    });

    it("refuses what a Done job or a wrong status doesn't allow, but relates a Done job", async () => {
        const { store, job, changes } = await openWithJob();
        const other = (await store.insertJob(newJob("E"))).job;
        changes.length = 0;
        await assert.rejects(store.applyAction(job.number, "resume", {}, lead), refusal("conflict"));
        await assert.rejects(store.applyAction(job.number, "block", { blockedReason: "x" }, lead), refusal("conflict"));
        await store.applyAction(job.number, "cancel", { justification: "not needed" }, member);
        const finalState = await store.getJob(job.number);
        assert.deepEqual(finalState.resolution, { kind: "cancelled", justification: "not needed" });
        const before = (await store.listHistory(job.number, {})).entries.length;
        await assert.rejects(store.updateFields(job.number, { title: "x" }, member), refusal("conflict"));
        await assert.rejects(store.addWorklog(job.number, "late", member), refusal("conflict"));
        await assert.rejects(store.applyAction(job.number, "start", {}, daemon), refusal("conflict"));
        assert.deepEqual(await store.getJob(job.number), finalState);
        assert.equal((await store.listHistory(job.number, {})).entries.length, before);
        assert.deepEqual((await store.listWorklog(job.number, {})).entries, []);
        const related = await store.relate(job.number, other.number, member);
        assert.deepEqual(related.a.related, [other.number]);
        const unrelated = await store.unrelate(job.number, other.number, member);
        assert.deepEqual(unrelated.a.related, []);
        assert.deepEqual(
            changes.map((c) => c.type),
            ["job_done", "related_changed", "related_changed"],
        );
    });

    it("judges a complete by the stored definition of done", async () => {
        const { store, job } = await openWithJob();
        await store.applyAction(job.number, "start", {}, daemon);
        await assert.rejects(
            store.applyAction(job.number, "complete", { justification: "x" }, lead),
            refusal("invalid_input", "definitionOfDone"),
        );
        await store.updateFields(job.number, { definitionOfDone: "done when X" }, lead);
        const done = await store.applyAction(job.number, "complete", { justification: "X holds" }, lead);
        assert.equal(done.status, "done");
    });

    it("relates two jobs once, in both directions, and refuses a job related to itself", async () => {
        const { store, job, changes } = await openWithJob();
        const other = (await store.insertJob(newJob("E"))).job;
        changes.length = 0;
        await store.relate(job.number, other.number, lead);
        const again = await store.relate(other.number, job.number, lead);
        assert.deepEqual(again.a.related, [job.number]);
        assert.deepEqual(again.b.related, [other.number]);
        await assert.rejects(store.relate(job.number, job.id, lead), refusal("invalid_input", "jobs"));
        for (const number of [job.number, other.number]) {
            const { entries } = await store.listHistory(number, {});
            assert.equal(entries.length, 1);
            assert.equal(entries[0]?.field, "related");
        }
        assert.deepEqual(changes, [{ type: "related_changed", numbers: [job.number, other.number] }]);
    });

    it("writes the Related link of an insert in the insert's own transaction", async () => {
        const { db, store, job } = await openWithJob();
        const added = (await store.insertJob(newJob("W", { relatedTo: job.number, author: lead }))).job;
        assert.deepEqual(added.related, [job.number]);
        assert.deepEqual((await store.getJob(job.number)).related, [added.number]);
        for (const number of [job.number, added.number]) {
            const { entries } = await store.listHistory(number, {});
            assert.deepEqual(
                entries.map((e) => e.field),
                ["related"],
            );
        }
        await assert.rejects(store.insertJob(newJob("W", { relatedTo: "C-99" })), JobNotFoundError);
        assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM intern_jobs"))?.n, 2);
        assert.equal((await store.insertJob(newJob("W"))).job.number, "W-2");
    });

    it("pages the worklog and the history oldest first", async () => {
        const { store, job } = await openWithJob();
        for (const text of ["one", "two", "three"]) await store.addWorklog(job.number, text, lead);
        await assert.rejects(store.addWorklog(job.number, "  ", lead), refusal("invalid_input", "text"));
        const first = await store.listWorklog(job.number, { limit: 2 });
        assert.deepEqual(
            first.entries.map((e) => e.text),
            ["one", "two"],
        );
        assert.ok(first.cursor);
        const second = await store.listWorklog(job.number, { limit: 2, cursor: first.cursor });
        assert.deepEqual(
            second.entries.map((e) => e.text),
            ["three"],
        );
        assert.equal(second.cursor, undefined);
        assert.deepEqual(second.entries[0]?.author, lead);
        for (const title of ["a", "b", "c"]) await store.updateFields(job.number, { title }, member);
        const page = await store.listHistory(job.number, { limit: 2 });
        const rest = await store.listHistory(job.number, { cursor: page.cursor });
        assert.deepEqual(
            [...page.entries, ...rest.entries].map((e) => e.new),
            ["a", "b", "c"],
        );
        await assert.rejects(store.listHistory(job.number, { cursor: "nope" }), RangeError);
    });

    it("reports each committed change after the commit, and nothing for a refusal or a repair", async () => {
        const { store, job, changes } = await openWithJob();
        await store.updateFields(job.number, { description: "d" }, member);
        await store.addWorklog(job.number, "note", lead);
        await store.applyAction(job.number, "start", {}, daemon);
        await store.applyAction(job.number, "block", { blockedReason: "why" }, lead);
        await store.applyAction(job.number, "resume", {}, daemon);
        assert.deepEqual(
            changes.map((c) => c.type),
            ["job_changed", "worklog_added", "status_changed", "status_changed", "status_changed"],
        );
        assert.deepEqual(changes[0], { type: "job_changed", number: job.number, fields: { description: "d" } });
        assert.deepEqual(changes[3], {
            type: "status_changed",
            number: job.number,
            old: "in_progress",
            new: "blocked",
            blockedReason: "why",
        });
        const count = changes.length;
        await assert.rejects(store.updateFields(job.number, { status: "x" } as never, member), JobRefusedError);
        await store.recordRepair(job.number, { rule: 2, did: "resumed" });
        assert.equal(changes.length, count);
        const last = (await store.listHistory(job.number, {})).entries.at(-1);
        assert.deepEqual(last && [last.author, last.field, last.old, last.new], [
            daemon,
            "repair",
            null,
            { rule: 2, did: "resumed" },
        ]);
        await store.applyAction(job.number, "cancel", { justification: "no" }, member);
        assert.deepEqual(changes.at(-1), {
            type: "job_done",
            number: job.number,
            resolution: { kind: "cancelled", justification: "no" },
        });
        assert.equal(changes.length, count + 1);
    });
});
