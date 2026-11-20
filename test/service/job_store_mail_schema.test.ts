import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import {
    checkJobSchemaVersion,
    createJobStore,
    JOB_MIGRATIONS,
    JOB_SCHEMA_VERSION,
    JobSchemaTooNewError,
    migrateJobStore,
    type NewJob,
} from "../../src/jobs/job_store.ts";
import { jobRecordOperations } from "../../src/service/job_record_operations.ts";
import { createCatalogue, ServiceError } from "../../src/service/operations.ts";
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

const newJob = (extra: Partial<NewJob> = {}): NewJob => ({
    letter: "E",
    requestText: "a request",
    origin: { kind: "request", wayIn: "email" },
    leadStart: { role: "lead" },
    ...extra,
});

const names = (rows: { name: string }[]) => rows.map((row) => row.name).sort();

describe("job schema version 6", () => {
    it("migrates a version 5 database to the four mail tables, their keys and the job columns", async () => {
        const db = await openDb();
        await db.transaction(async (tx) => {
            for (let step = 0; step < 5; step++) await tx.exec(JOB_MIGRATIONS[step] as string);
            await tx.run("INSERT INTO intern_schema (id, version) VALUES (1, 5)");
        });
        await migrateJobStore(db);

        assert.equal(JOB_SCHEMA_VERSION, 6);
        const tables = await db.all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'intern_mail_%'",
        );
        assert.deepEqual(names(tables), [
            "intern_mail_intake",
            "intern_mail_messages",
            "intern_mail_outbox",
            "intern_mail_thread",
        ]);
        const columns = await db.all<{ name: string }>("SELECT name FROM pragma_table_info('intern_jobs')");
        for (const column of ["mail_account", "mail_message", "request_mark"]) {
            assert.ok(names(columns).includes(column), column);
        }
        const indexed = async (table: string, unique: boolean) =>
            (
                await db.all<{ columns: string }>(
                    `SELECT group_concat(c.name) AS columns FROM pragma_index_list('${table}') l
                     JOIN pragma_index_info(l.name) c WHERE l."unique" = ? GROUP BY l.name`,
                    unique ? 1 : 0,
                )
            ).map((row) => row.columns);
        assert.ok((await indexed("intern_mail_messages", true)).includes("account,uidvalidity,uid"));
        assert.ok((await indexed("intern_mail_outbox", true)).includes("key"));
        assert.ok((await indexed("intern_mail_thread", false)).includes("message_id"));
        assert.ok((await indexed("intern_jobs", false)).includes("mail_account"));
    });

    it("lists only one mail account's jobs, newest first, in pages with a cursor", async () => {
        const { db, store } = await openMigrated();
        const numbers: string[] = [];
        for (let index = 0; index < 5; index++) {
            const { job } = await store.insertJob(newJob({ requestText: `request ${index}` }));
            numbers.push(job.number);
        }
        for (const [index, number] of numbers.entries()) {
            if (index === 2) continue;
            const account = index === 4 ? "other" : "work";
            await db.run("UPDATE intern_jobs SET mail_account = ?, request_mark = 'mark' WHERE n = ?", account, index + 1);
            assert.ok(number);
        }

        const first = await store.listJobs({ mailAccount: "work", limit: 2 });
        assert.deepEqual(first.jobs.map((job) => job.number), [numbers[3], numbers[1]]);
        assert.ok(first.cursor);
        const second = await store.listJobs({ mailAccount: "work", limit: 2, cursor: first.cursor as string });
        assert.deepEqual(second.jobs.map((job) => job.number), [numbers[0]]);
        assert.equal(second.cursor, undefined);
        assert.equal(first.jobs[0]?.mailAccount, "work");
        assert.equal(first.jobs[0]?.requestMark, "mark");
    });

    it("returns a job that did not come by email without mailAccount and requestMark", async () => {
        const { store } = await openMigrated();
        const { job } = await store.insertJob(newJob());
        const read = await store.getJob(job.number);
        assert.equal("mailAccount" in read, false);
        assert.equal("requestMark" in read, false);
    });

    it("refuses jobs.list with a mailAccount that is not a string as invalid_input", async () => {
        const { store } = await openMigrated();
        const catalogue = createCatalogue(jobRecordOperations({} as never), {
            context: { jobStore: store } as unknown as ServiceContext,
            phase: () => "ready",
            logger: createLogger({ stream: { write: () => true } }),
        });
        const caller = { actor: { kind: "team_member" as const } };
        for (const bad of [5, true, {}, ""]) {
            await assert.rejects(catalogue.invoke("jobs.list", { mailAccount: bad }, caller), (error: unknown) => {
                assert.ok(error instanceof ServiceError);
                assert.equal(error.code, "invalid_input");
                return true;
            });
        }
        assert.deepEqual(await catalogue.invoke("jobs.list", { mailAccount: "work" }, caller), { jobs: [] });
    });

    it("refuses a database holding job schema version 7 as newer", async () => {
        const db = await openDb();
        await migrateJobStore(db);
        await db.run("UPDATE intern_schema SET version = 7");
        await assert.rejects(checkJobSchemaVersion(db), JobSchemaTooNewError);
        await assert.rejects(migrateJobStore(db), JobSchemaTooNewError);
    });
});
