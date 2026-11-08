/** Schedule entries at startup and their read operations (S-007 REQ-002, REQ-009: AC-002.1 to AC-002.3). */
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

const CONFIG_FILE = "config.toml";
const validEntry = { name: "weekly", cron: "0 3 * * 1", request: "Rotate the logs." };

const readConfig = (rig: ScheduleRig): Promise<string> => readFile(join(rig.env.configDir, CONFIG_FILE), "utf8");

const isRefusal =
    (code: string, ...mentions: string[]) =>
    (error: unknown) =>
        error instanceof ServiceError &&
        error.code === code &&
        mentions.every((text) => error.message.includes(text)) &&
        true;

describe("schedules.create", () => {
    const refusals: [string, Record<string, unknown>, string][] = [
        ["a name with a space", { ...validEntry, name: "two words" }, "name"],
        ["a bad cron", { ...validEntry, cron: "not cron" }, "cron"],
        ["a cron that never fires", { ...validEntry, cron: "0 0 31 2 *" }, "cron"],
        ["an empty request", {}, "name"],
        ["an unknown role", { ...validEntry, role: "ghost" }, "role"],
        ["an unregistered workspace", { ...validEntry, workspace: "/nowhere/at/all" }, "workspace"],
        ["an unknown model", { ...validEntry, model: "nowhere/missing-model" }, "model"],
        ["an invalid thinking level", { ...validEntry, thinkingLevel: "ultra" }, "thinkingLevel"],
    ];

    for (const [label, input, key] of refusals) {
        it(`refuses ${label} invalid_input naming ${key}, leaving the file unchanged (AC-001.1)`, {
            timeout: TEST_TIMEOUT_MS,
        }, async () => {
            const rig = await rigWith(entryToml());
            const before = await readConfig(rig);
            await assert.rejects(() => rig.invoke("schedules.create", input), isRefusal("invalid_input", key));
            assert.equal(await readConfig(rig), before);
            const listed = (await rig.invoke("schedules.list")) as Listed;
            assert.deepEqual(
                listed.schedules.map((entry) => entry.name),
                ["nightly"],
            );
        });
    }

    it("refuses a taken name conflict naming the entry, leaving the file unchanged (AC-001.3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const before = await readConfig(rig);
        await assert.rejects(
            () => rig.invoke("schedules.create", { ...validEntry, name: "nightly" }),
            isRefusal("conflict", "nightly"),
        );
        assert.equal(await readConfig(rig), before);
    });

    it("refuses with conflict naming the file after a hand edit, keeping the edit (AC-003.2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const file = join(rig.env.configDir, CONFIG_FILE);
        await writeFile(file, `${entryToml()}# edited by hand\n`);
        const edited = await readConfig(rig);
        await assert.rejects(() => rig.invoke("schedules.create", validEntry), isRefusal("conflict", file));
        assert.equal(await readConfig(rig), edited);
    });

    it("writes the entry to an owner-only file, returns it and publishes settings_changed (AC-004)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const subscription = (await rig.invoke("feed.subscribe", { scope: "instance" })) as {
            next(): Promise<{ done: boolean; value: { type: string; section?: string } }>;
        };
        const created = (await rig.invoke("schedules.create", { ...validEntry, thinkingLevel: "low" })) as {
            schedule: Listed["schedules"][number];
        };
        assert.equal(created.schedule.name, "weekly");
        assert.equal(created.schedule.nextDueTime, localTimeText(new Date(2026, 10, 9, 3, 0)));
        const file = join(rig.env.configDir, CONFIG_FILE);
        assert.match(await readConfig(rig), /name = "weekly"[\s\S]*thinking_level = "low"/);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        const delta = await subscription.next();
        assert.deepEqual(
            { type: delta.value.type, section: delta.value.section },
            { type: "settings_changed", section: "schedule" },
        );
    });

    it("returns the entry on a repeat with the same idempotencyKey and keeps one entry (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const input = { ...validEntry, idempotencyKey: "key-1" };
        const first = (await rig.invoke("schedules.create", input)) as { schedule: unknown };
        const second = (await rig.invoke("schedules.create", input)) as { schedule: unknown };
        assert.deepEqual(second, first);
        assert.equal((await readConfig(rig)).split('name = "weekly"').length, 2);
    });

    it("returns an identical existing entry when the key is not yet recorded (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        await rig.invoke("schedules.create", validEntry);
        const repeat = (await rig.invoke("schedules.create", { ...validEntry, idempotencyKey: "key-2" })) as {
            schedule: { name: string };
        };
        assert.equal(repeat.schedule.name, "weekly");
        assert.equal((await readConfig(rig)).split('name = "weekly"').length, 2);
    });

    it("keeps both entries of two creates of different names at once (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        await Promise.all([
            rig.invoke("schedules.create", { ...validEntry, name: "one" }),
            rig.invoke("schedules.create", { ...validEntry, name: "two" }),
        ]);
        const listed = (await rig.invoke("schedules.list")) as Listed;
        assert.deepEqual(listed.schedules.map((entry) => entry.name).sort(), ["nightly", "one", "two"]);
        assert.match(await readConfig(rig), /name = "one"[\s\S]*name = "two"|name = "two"[\s\S]*name = "one"/);
    });
});
