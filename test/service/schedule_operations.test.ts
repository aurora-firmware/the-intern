/** Schedule entries at startup and their read operations (S-007 REQ-002, REQ-009: AC-002.1 to AC-002.3). */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { localTimeText } from "../../src/schedules/schedule_time.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { type ScheduleRig, startScheduleRig } from "../support/schedule_rig.ts";

const rigs: ScheduleRig[] = [];
const TEST_TIMEOUT_MS = 60_000;
const FAILED_EXIT = 1;

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.dispose();
});

async function rigWith(configToml: string | ((env: ScheduleRig["env"]) => string)): Promise<ScheduleRig> {
    const rig = await startScheduleRig({ configToml });
    rigs.push(rig);
    return rig;
}

const entryToml = (extra = "", name = "nightly"): string =>
    `[[schedule]]\nname = "${name}"\ncron = "0 2 * * *"\nrequest = "Check the backups."\n${extra}`;

type Listed = { schedules: { name: string; cron: string; request: string; nextDueTime: string; model?: string }[] };

/** Asserts that startup failed at the step, naming the file, the entry key and the reason, and that no job exists. */
async function assertRefusedAtStartup(rig: ScheduleRig, step: number, key: string, reason: string): Promise<void> {
    assert.equal(await rig.exited(), FAILED_EXIT);
    const failure = rig
        .logs()
        .split("\n")
        .find((line) => line.includes("startup failed"));
    assert.ok(failure, `startup failure is logged in: ${rig.logs()}`);
    assert.match(failure, new RegExp(`step=${step}\\b`));
    assert.ok(failure.includes(`${rig.env.configDir}/config.toml`), `names the file in: ${failure}`);
    assert.ok(failure.includes(key), `names ${key} in: ${failure}`);
    assert.ok(failure.includes(reason), `gives the reason ${reason} in: ${failure}`);
}

async function assertNoJob(rig: ScheduleRig): Promise<void> {
    await rig.restart("");
    const listed = (await rig.invoke("jobs.list")) as { jobs: unknown[] };
    assert.deepEqual(listed.jobs, []);
}

describe("schedule entries at startup", () => {
    it("lists a hand-written entry with its next due time (AC-002.1)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml('role = "bob"\nthinking_level = "low"\n'));
        const listed = (await rig.invoke("schedules.list")) as Listed;
        assert.equal(listed.schedules.length, 1);
        assert.equal(listed.schedules[0]?.name, "nightly");
        assert.equal(listed.schedules[0]?.nextDueTime, localTimeText(new Date(2026, 10, 8, 2, 0)));
        const got = (await rig.invoke("schedules.get", { name: "nightly" })) as {
            schedule: Listed["schedules"][number];
        };
        assert.deepEqual(got.schedule, listed.schedules[0]);
    });

    it("fails startup on a bad cron, naming the file, entry and reason (AC-002.2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml().replace("0 2 * * *", "61 2 * * *"));
        await assertRefusedAtStartup(rig, 1, "nightly.cron", "cron");
        await assertNoJob(rig);
    });

    it("fails startup on an unknown key (AC-002.2)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml('colour = "red"\n'));
        await assertRefusedAtStartup(rig, 1, "nightly.colour", "is not a schedule setting");
        await assertNoJob(rig);
    });

    it("fails startup at step 6 on an unknown role (AC-002.2)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml('role = "ghost"\n'));
        await assertRefusedAtStartup(rig, 6, "schedule.nightly.role", "ghost");
        await assertNoJob(rig);
    });

    it("fails startup at step 6 on an unregistered workspace (AC-002.2)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith((env) => entryToml(`workspace = "${env.root}/nowhere"\n`));
        await assertRefusedAtStartup(rig, 6, "schedule.nightly.workspace", "not registered");
        await assertNoJob(rig);
    });

    it("reports ready and lists an entry whose model is unavailable (AC-002.3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml('model = "nowhere/missing-model"\n'));
        assert.ok(rig.isReady());
        const listed = (await rig.invoke("schedules.list")) as Listed;
        assert.equal(listed.schedules[0]?.model, "nowhere/missing-model");
    });

    it("refuses schedules.get for an unknown name (AC-5)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml());
        await assert.rejects(
            () => rig.invoke("schedules.get", { name: "missing" }),
            (error) => error instanceof ServiceError && error.code === "not_found" && error.message.includes("missing"),
        );
    });
});
