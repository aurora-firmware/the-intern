import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import {
    createJobStore,
    type JobChange,
    migrateJobStore,
    type NewJob,
    type ScheduleSkip,
} from "../../src/jobs/job_store.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type Db = Awaited<ReturnType<typeof openHostDatabase>>;

const envs: HermeticEnv[] = [];
const databases: Db[] = [];

afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
    for (const env of envs.splice(0)) await env.dispose();
});

async function openStore() {
    const env = await createHermeticEnv();
    envs.push(env);
    const db = await openHostDatabase(join(env.dataDir, "bob.sqlite"));
    databases.push(db);
    await migrateJobStore(db);
    return createJobStore(db);
}

const at = (minute: string): string => `2026-11-08T${minute}:00.000Z`;

const skip = (entry: string, minute: string, extra: Partial<ScheduleSkip> = {}): ScheduleSkip => ({
    entry,
    dueAt: at(minute),
    dueTime: `local ${minute}`,
    reason: "the folder is gone",
    openRun: null,
    ...extra,
});

const run = (entry: string, minute: string): NewJob => ({
    letter: "S",
    requestText: "request",
    origin: { kind: "request", wayIn: "command line" },
    leadStart: {},
    schedule: { entry, firedAt: at(minute) },
});

/** Writes a run and finishes it, so the entry has no open run for the next one. */
async function addRun(store: Awaited<ReturnType<typeof openStore>>, entry: string, minute: string): Promise<string> {
    const { job } = await store.insertJob(run(entry, minute));
    await store.applyAction(job.number, "cancel", { justification: "done with it" }, { kind: "daemon" });
    return job.number;
}

const labels = (items: Awaited<ReturnType<Awaited<ReturnType<typeof openStore>>["listScheduleRuns"]>>["items"]) =>
    items.map((item) => (item.kind === "run" ? `run ${item.job.number}` : `skip ${item.skip.dueAt.slice(11, 16)}`));

/** Writes a run fired at the given ISO text, in whatever offset, and finishes it. */
async function addRunAt(store: Awaited<ReturnType<typeof openStore>>, entry: string, firedAt: string): Promise<string> {
    const { job } = await store.insertJob({ ...run(entry, "00:00"), schedule: { entry, firedAt } });
    await store.applyAction(job.number, "cancel", { justification: "done with it" }, { kind: "daemon" });
    return job.number;
}

const skipAt = (entry: string, dueAt: string): ScheduleSkip => ({
    entry,
    dueAt,
    dueTime: `local ${dueAt}`,
    reason: "the folder is gone",
    openRun: null,
});

async function allPages(store: Awaited<ReturnType<typeof openStore>>, entry: string, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await store.listScheduleRuns(entry, { limit, cursor });
        assert.ok(page.items.length <= limit);
        seen.push(...labels(page.items));
        cursor = page.cursor;
    } while (cursor !== undefined);
    return seen;
}

describe("schedule history across UTC offsets", () => {
    it("lists a newer UTC skip before an older run stored with a local offset", async () => {
        const store = await openStore();
        const older = await addRunAt(store, "e", "2026-11-08T01:01:00.000+01:00");
        await store.recordSkip(skipAt("e", "2026-11-08T00:02:00.000Z"));
        assert.deepEqual(labels((await store.listScheduleRuns("e", {})).items), ["skip 00:02", `run ${older}`]);
        assert.deepEqual(labels((await store.listScheduleRuns("e", { limit: 1 })).items), ["skip 00:02"]);
    });

    it("lists a run before a skip at the same instant written in different offsets", async () => {
        const store = await openStore();
        await store.recordSkip(skipAt("e", "2026-11-08T00:01:00.000Z"));
        const same = await addRunAt(store, "e", "2026-11-08T01:01:00.000+01:00");
        assert.deepEqual(labels((await store.listScheduleRuns("e", {})).items), [`run ${same}`, "skip 00:01"]);
    });

    it("orders by instant across a change of offset", async () => {
        const store = await openStore();
        const before = await addRunAt(store, "e", "2026-10-25T02:30:00.000+02:00");
        const after = await addRunAt(store, "e", "2026-10-25T02:10:00.000+01:00");
        await store.recordSkip(skipAt("e", "2026-10-25T00:45:00.000Z"));
        assert.deepEqual(labels((await store.listScheduleRuns("e", {})).items), [
            `run ${after}`,
            "skip 00:45",
            `run ${before}`,
        ]);
    });

    it("pages the mix one item at a time with nothing lost or repeated", async () => {
        const store = await openStore();
        const a = await addRunAt(store, "e", "2026-11-08T01:01:00.000+01:00");
        await store.recordSkip(skipAt("e", "2026-11-08T00:02:00.000Z"));
        const b = await addRunAt(store, "e", "2026-11-08T01:04:00.000+01:00");
        await store.recordSkip(skipAt("e", "2026-11-08T00:05:00.000Z"));
        const c = await addRunAt(store, "e", "2026-11-08T01:06:00.000+01:00");
        const expected = [`run ${c}`, "skip 00:05", `run ${b}`, "skip 00:02", `run ${a}`];
        assert.deepEqual(labels((await store.listScheduleRuns("e", {})).items), expected);
        for (const limit of [1, 2, 3]) assert.deepEqual(await allPages(store, "e", limit), expected, `limit ${limit}`);
    });

    it("returns the run with the latest instant as the entry's latest run", async () => {
        const store = await openStore();
        await addRunAt(store, "e", "2026-11-08T09:00:00.000+10:00");
        const newest = await addRunAt(store, "e", "2026-11-08T00:30:00.000Z");
        assert.equal((await store.latestScheduledRun("e"))?.number, newest);
    });
});

describe("schedule history", () => {
    it("writes a new skip and reports it after the commit", async () => {
        const store = await openStore();
        const changes: JobChange[] = [];
        store.onCommit((change) => changes.push(change));
        await store.recordSkip(skip("daily", "08:00", { reason: "S-1 is still open", openRun: "S-1" }));
        assert.deepEqual(changes, [
            {
                type: "schedule_fire_skipped",
                skip: skip("daily", "08:00", { reason: "S-1 is still open", openRun: "S-1" }),
            },
        ]);
        const page = await store.listScheduleRuns("daily", {});
        assert.deepEqual(page.items, [
            { kind: "skip", skip: skip("daily", "08:00", { reason: "S-1 is still open", openRun: "S-1" }) },
        ]);
    });

    it("writes and reports nothing when the same entry and due time are recorded again", async () => {
        const store = await openStore();
        const changes: JobChange[] = [];
        store.onCommit((change) => changes.push(change));
        await store.recordSkip(skip("daily", "08:00"));
        await store.recordSkip(skip("daily", "08:00", { reason: "a different reason" }));
        assert.equal(changes.length, 1);
        const { items } = await store.listScheduleRuns("daily", {});
        assert.equal(items.length, 1);
        assert.equal(items[0]?.kind === "skip" && items[0].skip.reason, "the folder is gone");
    });

    it("lists runs and skips newest first, a run before a skip at the same minute", async () => {
        const store = await openStore();
        const first = await addRun(store, "daily", "07:00");
        await store.recordSkip(skip("daily", "07:30"));
        const second = await addRun(store, "daily", "08:00");
        await store.recordSkip(skip("daily", "08:00"));
        await store.recordSkip(skip("other", "09:00"));
        await addRun(store, "other", "09:30");
        const { items } = await store.listScheduleRuns("daily", {});
        assert.deepEqual(labels(items), [`run ${second}`, "skip 08:00", "skip 07:30", `run ${first}`]);
    });

    it("continues each page from its cursor with no item repeated or lost", async () => {
        const store = await openStore();
        for (const minute of ["01:00", "02:00", "03:00", "04:00"]) await addRun(store, "daily", minute);
        for (const minute of ["01:00", "02:30", "03:00", "05:00"]) await store.recordSkip(skip("daily", minute));
        const everything = labels((await store.listScheduleRuns("daily", {})).items);
        assert.equal(everything.length, 8);
        for (const limit of [1, 2, 3, 5]) {
            const seen: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await store.listScheduleRuns("daily", { limit, cursor });
                assert.ok(page.items.length <= limit);
                seen.push(...labels(page.items));
                cursor = page.cursor;
            } while (cursor !== undefined);
            assert.deepEqual(seen, everything, `limit ${limit}`);
        }
    });

    it("returns no cursor on the last page", async () => {
        const store = await openStore();
        await store.recordSkip(skip("daily", "08:00"));
        await store.recordSkip(skip("daily", "09:00"));
        assert.equal((await store.listScheduleRuns("daily", { limit: 2 })).cursor, undefined);
    });

    it("refuses a limit out of range and a cursor the store did not return", async () => {
        const store = await openStore();
        await assert.rejects(store.listScheduleRuns("daily", { limit: 0 }), RangeError);
        await assert.rejects(store.listScheduleRuns("daily", { cursor: "nonsense" }), RangeError);
    });

    it("returns an empty page and no latest run for an entry with no jobs and no skips", async () => {
        const store = await openStore();
        assert.deepEqual(await store.listScheduleRuns("daily", {}), { items: [] });
        assert.equal(await store.latestScheduledRun("daily"), undefined);
    });

    it("returns the entry's newest job as its latest run", async () => {
        const store = await openStore();
        await addRun(store, "daily", "07:00");
        const newest = await addRun(store, "daily", "08:00");
        await addRun(store, "other", "09:00");
        assert.equal((await store.latestScheduledRun("daily"))?.number, newest);
    });
});
