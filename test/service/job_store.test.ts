import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import {
    checkJobSchemaVersion,
    createJobStore,
    JOB_SCHEMA_VERSION,
    JobNotFoundError,
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

describe("job store inserts", () => {
    it("numbers jobs per letter and uses no number for a repeated idempotency key", async () => {
        const { store } = await openMigrated();
        const seen: string[] = [];
        store.onCommit((change) => seen.push(change.job.number));
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
