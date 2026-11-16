/** Schedule entries at startup and their read operations (S-007 REQ-002, REQ-009: AC-002.1 to AC-002.3). */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { localTimeText } from "../../src/schedules/schedule_time.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { type ScheduleRig, startScheduleRig } from "../support/schedule_rig.ts";
import { scaled } from "../support/time_scale.ts";

const rigs: ScheduleRig[] = [];
const TEST_TIMEOUT_MS = scaled(60_000);
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
        const rig = await rigWith(entryToml('role = "bob"\nthinking_level = "off"\n'));
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
        error instanceof ServiceError && error.code === code && mentions.every((text) => error.message.includes(text));

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
            next(): Promise<{ delta?: { type: string; section?: string } }>;
        };
        const created = (await rig.invoke("schedules.create", { ...validEntry, thinkingLevel: "off" })) as {
            schedule: Listed["schedules"][number];
        };
        assert.equal(created.schedule.name, "weekly");
        assert.equal(created.schedule.nextDueTime, localTimeText(new Date(2026, 10, 9, 3, 0)));
        const file = join(rig.env.configDir, CONFIG_FILE);
        assert.match(await readConfig(rig), /name = "weekly"[\s\S]*thinking_level = "off"/);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        const { delta } = await subscription.next();
        assert.deepEqual(
            { type: delta?.type, section: delta?.section },
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

const FAKE_MODEL = "faux/faux-1";
const GONE_MODEL = "nowhere/missing-model";

type Changed = { schedule: Listed["schedules"][number] & Record<string, unknown> };

describe("schedules.change", () => {
    it("moves the next due time, writes the file and keeps it after a restart (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const changed = (await rig.invoke("schedules.change", { name: "nightly", cron: "0 3 * * *" })) as Changed;
        const at3 = localTimeText(new Date(2026, 10, 8, 3, 0));
        assert.equal(changed.schedule.nextDueTime, at3);
        assert.match(await readConfig(rig), /cron = "0 3 \* \* \*"/);
        assert.doesNotMatch(await readConfig(rig), /0 2 \* \* \*/);
        await rig.restart();
        const got = (await rig.invoke("schedules.get", { name: "nightly" })) as Changed;
        assert.equal(got.schedule.nextDueTime, at3);
    });

    it("clears a value given null and leaves the values absent from the input (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml(`role = "bob"\nmodel = "${FAKE_MODEL}"\nthinking_level = "off"\n`));
        const { schedule } = (await rig.invoke("schedules.change", { name: "nightly", role: null })) as Changed;
        assert.equal("role" in schedule, false);
        assert.equal(schedule.model, FAKE_MODEL);
        assert.equal(schedule.thinkingLevel, "off");
        assert.equal(schedule.request, "Check the backups.");
        const text = await readConfig(rig);
        assert.doesNotMatch(text, /role =/);
        assert.match(text, /thinking_level = "off"/);
    });

    it("clears the model, thinking level and workspace given null (AC-2)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml(`model = "${FAKE_MODEL}"\nthinking_level = "off"\n`));
        const { schedule } = (await rig.invoke("schedules.change", {
            name: "nightly",
            model: null,
            thinkingLevel: null,
            workspace: null,
        })) as Changed;
        assert.deepEqual(Object.keys(schedule).sort(), ["cron", "name", "nextDueTime", "request"]);
        assert.doesNotMatch(await readConfig(rig), /model =|thinking_level =/);
    });

    it("refuses clearing the cron or the request, and a changed name, leaving the file unchanged (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const before = await readConfig(rig);
        for (const [change, key] of [
            [{ cron: null }, "cron"],
            [{ request: null }, "request"],
            [{ cron: "not cron" }, "cron"],
            [{ name: "nightly", colour: "red" }, "colour"],
            [{ colour: null }, "colour"],
        ] as const) {
            await assert.rejects(
                () => rig.invoke("schedules.change", { name: "nightly", ...change }),
                isRefusal("invalid_input", key),
            );
        }
        assert.equal(await readConfig(rig), before);
    });

    it("refuses a change that leaves a gone model, naming the model (AC-3)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml(`model = "${GONE_MODEL}"\n`));
        const before = await readConfig(rig);
        await assert.rejects(
            () => rig.invoke("schedules.change", { name: "nightly", cron: "0 3 * * *" }),
            isRefusal("invalid_input", "model", GONE_MODEL),
        );
        assert.equal(await readConfig(rig), before);
    });

    it("accepts a change that sets another model or clears the gone one (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(
            entryToml(`model = "${GONE_MODEL}"\n`, "one") + entryToml(`model = "${GONE_MODEL}"\n`, "two"),
        );
        const set = (await rig.invoke("schedules.change", { name: "one", model: FAKE_MODEL })) as Changed;
        assert.equal(set.schedule.model, FAKE_MODEL);
        const cleared = (await rig.invoke("schedules.change", { name: "two", model: null })) as Changed;
        assert.equal("model" in cleared.schedule, false);
    });

    it("refuses an unknown name not_found, naming it (AC-4)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml());
        const before = await readConfig(rig);
        await assert.rejects(
            () => rig.invoke("schedules.change", { name: "missing", cron: "0 3 * * *" }),
            isRefusal("not_found", "missing"),
        );
        assert.equal(await readConfig(rig), before);
    });

    it("refuses with conflict naming the file after a hand edit, keeping the edit (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const file = join(rig.env.configDir, CONFIG_FILE);
        await writeFile(file, `${entryToml()}# edited by hand\n`);
        const edited = await readConfig(rig);
        await assert.rejects(
            () => rig.invoke("schedules.change", { name: "nightly", cron: "0 3 * * *" }),
            isRefusal("conflict", file),
        );
        assert.equal(await readConfig(rig), edited);
    });
});

describe("schedules.remove", () => {
    it("filters the entry out of the file and the list, and keeps the others (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml("", "one") + entryToml("", "two"));
        const removed = await rig.invoke("schedules.remove", { name: "one" });
        assert.deepEqual(removed, {});
        const listed = (await rig.invoke("schedules.list")) as Listed;
        assert.deepEqual(
            listed.schedules.map((entry) => entry.name),
            ["two"],
        );
        assert.doesNotMatch(await readConfig(rig), /name = "one"/);
        assert.match(await readConfig(rig), /name = "two"/);
    });

    it("refuses an unknown name not_found, naming it (AC-4)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await rigWith(entryToml());
        const before = await readConfig(rig);
        await assert.rejects(
            () => rig.invoke("schedules.remove", { name: "missing" }),
            isRefusal("not_found", "missing"),
        );
        assert.equal(await readConfig(rig), before);
    });

    it("refuses with conflict naming the file after a hand edit, keeping the edit (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const file = join(rig.env.configDir, CONFIG_FILE);
        await writeFile(file, `${entryToml()}# edited by hand\n`);
        const edited = await readConfig(rig);
        await assert.rejects(() => rig.invoke("schedules.remove", { name: "nightly" }), isRefusal("conflict", file));
        assert.equal(await readConfig(rig), edited);
    });
});

describe("the holds on roles and workspaces an entry names", () => {
    const reviewer = { name: "reviewer", instructions: "Review the work.", tools: ["read"], skills: [] };
    type Roles = { roles: { name: string }[] };
    type Workspaces = { workspaces: { path: string; kind: string; role?: string }[] };

    const hasRole = async (rig: ScheduleRig, name: string): Promise<boolean> =>
        ((await rig.invoke("roles.list")) as Roles).roles.some((role) => role.name === name);

    const makeFolder = async (rig: ScheduleRig, name: string): Promise<string> => {
        const path = join(rig.env.root, name);
        await mkdir(path);
        await chmod(path, 0o700);
        await rig.invoke("workspaces.register", { path });
        return path;
    };

    const defaultWorkspaceOf = async (rig: ScheduleRig, role: string): Promise<string> => {
        const listed = (await rig.invoke("workspaces.list")) as Workspaces;
        const found = listed.workspaces.find((entry) => entry.kind === "role_default" && entry.role === role);
        assert.ok(found, `${role} has a per-role default workspace`);
        return found.path;
    };

    it("refuses removing a role an entry names, naming the entry, and changes nothing (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        await rig.invoke("roles.create", reviewer);
        await rig.invoke("schedules.create", { name: "nightly", cron: "0 2 * * *", request: "Go.", role: "reviewer" });
        const before = await readConfig(rig);
        await assert.rejects(() => rig.invoke("roles.remove", { name: "reviewer" }), isRefusal("conflict", "nightly"));
        assert.equal(await hasRole(rig, "reviewer"), true);
        assert.equal(await readConfig(rig), before);
    });

    it("refuses unregistering a workspace an entry names, naming the entry, and changes nothing (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        const path = await makeFolder(rig, "project");
        await rig.invoke("schedules.create", { name: "nightly", cron: "0 2 * * *", request: "Go.", workspace: path });
        const before = await readConfig(rig);
        await assert.rejects(() => rig.invoke("workspaces.unregister", { path }), isRefusal("conflict", "nightly"));
        const listed = (await rig.invoke("workspaces.list")) as Workspaces;
        assert.ok(listed.workspaces.some((entry) => entry.path === path));
        assert.equal(await readConfig(rig), before);
    });

    it("refuses removing a role whose per-role default workspace an entry names (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        await rig.invoke("roles.create", reviewer);
        const path = await defaultWorkspaceOf(rig, "reviewer");
        await rig.invoke("schedules.create", { name: "nightly", cron: "0 2 * * *", request: "Go.", workspace: path });
        const before = await readConfig(rig);
        await assert.rejects(() => rig.invoke("roles.remove", { name: "reviewer" }), isRefusal("conflict", "nightly"));
        assert.equal(await hasRole(rig, "reviewer"), true);
        assert.equal(await readConfig(rig), before);
    });

    it("removes a role whose set default workspace an entry names, and keeps the entry (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        const path = await makeFolder(rig, "project");
        await rig.invoke("roles.create", { ...reviewer, workspace: path });
        await rig.invoke("schedules.create", { name: "nightly", cron: "0 2 * * *", request: "Go.", workspace: path });
        await rig.invoke("roles.remove", { name: "reviewer" });
        assert.equal(await hasRole(rig, "reviewer"), false);
        const listed = (await rig.invoke("schedules.list")) as Listed;
        assert.deepEqual(
            listed.schedules.map((entry) => entry.name),
            ["nightly"],
        );
    });

    it("removes a role and unregisters a workspace that no entry names (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const path = await makeFolder(rig, "project");
        await rig.invoke("roles.create", reviewer);
        await rig.invoke("roles.remove", { name: "reviewer" });
        assert.equal(await hasRole(rig, "reviewer"), false);
        await rig.invoke("workspaces.unregister", { path });
        const listed = (await rig.invoke("workspaces.list")) as Workspaces;
        assert.ok(!listed.workspaces.some((entry) => entry.path === path));
    });
});

describe("schedule run history", () => {
    it("retains skipped fires through export and import", { timeout: TEST_TIMEOUT_MS }, async () => {
        const { startExportDaemon, waitFor } = await import("../support/export_daemon.ts");
        const { runDaemon } = await import("../../src/daemon/daemon.ts");
        const { jobExportOperation } = await import("../../src/service/job_export_operation.ts");
        const { createLocalSocketComponent } = await import("../../src/listeners/local_socket.ts");
        const { networkSection } = await import("../../src/listeners/network_section.ts");
        const { runBob } = await import("../support/bob_process.ts");
        const { scheduleOperations } = await import("../../src/service/schedule_operations.ts");
        const { createCatalogue } = await import("../../src/service/operations.ts");
        const { createLogger } = await import("../../src/daemon/logger.ts");
        const source = await startExportDaemon();
        let restarted: ReturnType<typeof runDaemon> | undefined;
        try {
            const store = source.ctx().jobStore;
            for (const [minute, action] of [
                ["06", "complete"],
                ["07", "cancel"],
            ] as const) {
                const { job } = await store.insertJob({
                    letter: "S",
                    requestText: "request",
                    origin: {
                        kind: "schedule",
                        entry: "nightly",
                        fireTime: `2026-11-08T${minute}:00:00.000Z`,
                        ...(action === "complete" && { onDemand: { wayIn: "command line" } }),
                    },
                    leadStart: {},
                    schedule: { entry: "nightly", firedAt: `2026-11-08T${minute}:00:00.000Z` },
                });
                if (action === "complete") await store.applyAction(job.number, "start", {}, { kind: "daemon" });
                await store.applyAction(
                    job.number,
                    action,
                    { justification: action, definitionOfDone: "done" },
                    { kind: "daemon" },
                );
            }
            await source.ctx().jobStore.recordSkip({
                entry: "nightly",
                dueAt: "2026-11-08T08:00:00.000Z",
                dueTime: "local time",
                reason: "busy",
                openRun: null,
            });
            const operations = scheduleOperations(
                { clock: { now: () => new Date(), wait: async () => {} } },
                {
                    runtime: () => {
                        throw new Error("not used");
                    },
                },
            );
            const catalogue = createCatalogue(operations, {
                context: source.ctx(),
                phase: () => "ready",
                logger: createLogger({ stream: { write: () => true } }),
            });
            const readSource = () =>
                catalogue.invoke("schedules.runs", { name: "nightly" }, { actor: { kind: "team_member" } });
            const expected = [
                { kind: "skip", dueTime: "local time", reason: "busy" },
                {
                    kind: "run",
                    number: "S-2",
                    firedAt: "2026-11-08T07:00:00.000Z",
                    status: "done",
                    resolution: { kind: "cancelled", justification: "cancel" },
                    onDemand: undefined,
                },
                {
                    kind: "run",
                    number: "S-1",
                    firedAt: "2026-11-08T06:00:00.000Z",
                    status: "done",
                    resolution: { kind: "completed", justification: "complete" },
                    onDemand: { wayIn: "command line" },
                },
            ];
            const fields = (result: unknown) =>
                (result as { items: import("../../src/jobs/job_store.ts").ScheduleRunItem[] }).items.map((item) =>
                    item.kind === "skip"
                        ? { kind: item.kind, dueTime: item.skip.dueTime, reason: item.skip.reason }
                        : {
                              kind: item.kind,
                              number: item.job.number,
                              firedAt: item.firedAt,
                              status: item.job.status,
                              resolution: item.job.resolution,
                              onDemand:
                                  item.job.request.origin.kind === "schedule"
                                      ? item.job.request.origin.onDemand
                                      : undefined,
                          },
                );
            assert.deepEqual(fields(await readSource()), expected);
            await source.daemon.stop();
            const sourceRestarted = runDaemon({
                flags: {
                    configDir: source.env.configDir,
                    stateDir: source.env.stateDir,
                    dataDir: source.env.dataDir,
                    runtimeDir: source.env.runtimeDir,
                },
                env: source.env.env,
                homeDir: source.env.root,
                logger: createLogger({ stream: { write: () => true } }),
                sections: [networkSection],
                components: [createLocalSocketComponent()],
                operations: [...operations, jobExportOperation],
            });
            restarted = sourceRestarted;
            await waitFor(() => sourceRestarted.phase() === "ready", "the source daemon to restart");
            assert.deepEqual(
                fields(
                    await sourceRestarted.catalogue.invoke(
                        "schedules.runs",
                        { name: "nightly" },
                        { actor: { kind: "team_member" } },
                    ),
                ),
                expected,
            );
            const exported = await runBob(["export", "backup.db"], {
                runtimeDir: source.env.runtimeDir,
                env: source.env.env,
                cwd: source.env.root,
            });
            assert.equal(exported.status, 0, exported.stderr);
            const target = await rigWith("");
            await target.daemon().stop();
            await rm(join(target.env.stateDir, "the-intern.sqlite"));
            const imported = await runBob(
                [
                    "import",
                    join(source.env.root, "backup.db"),
                    "--config-dir",
                    target.env.configDir,
                    "--state-dir",
                    target.env.stateDir,
                    "--data-dir",
                    target.env.dataDir,
                    "--runtime-dir",
                    target.env.runtimeDir,
                ],
                { env: target.env.env },
            );
            assert.equal(imported.status, 0, imported.stderr);
            await target.restart();
            const history = (await target.invoke("schedules.runs", { name: "nightly" })) as {
                items: { kind: string; skip: { reason: string } }[];
            };
            assert.deepEqual(fields(history), expected);
            await target.restart();
            assert.deepEqual(fields(await target.invoke("schedules.runs", { name: "nightly" })), expected);
            assert.deepEqual(((await target.invoke("schedules.list")) as Listed).schedules, []);
        } finally {
            await restarted?.stop();
            await source.stop();
        }
    });

    it("returns history for configured and removed entries, and refuses unknown entries", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml());
        const { openHostDatabase } = await import("../../src/host/harness_host.ts");
        const { createJobStore } = await import("../../src/jobs/job_store.ts");
        const db = await openHostDatabase(join(rig.env.stateDir, "the-intern.sqlite"));
        try {
            const store = createJobStore(db);
            const { job } = await store.insertJob({
                letter: "S",
                requestText: "request",
                origin: { kind: "request", wayIn: "command line" },
                leadStart: {},
                schedule: { entry: "nightly", firedAt: "2026-11-08T07:00:00.000Z" },
            });
            await store.applyAction(job.number, "cancel", { justification: "cancelled" }, { kind: "daemon" });
            await store.insertJob({
                letter: "S",
                requestText: "other",
                origin: { kind: "request", wayIn: "command line" },
                leadStart: {},
                schedule: { entry: "other", firedAt: "2026-11-08T07:00:00.000Z" },
            });
            await store.insertJob({
                letter: "C",
                requestText: "ordinary",
                origin: { kind: "request", wayIn: "command line" },
                leadStart: {},
            });
            await store.recordSkip({
                entry: "nightly",
                dueAt: "2026-11-08T08:00:00.000Z",
                dueTime: "local time",
                reason: "busy",
                openRun: job.number,
            });
            const history = await rig.invoke("schedules.runs", { name: "nightly" });
            const page = history as { items: { kind: string }[] };
            assert.deepEqual(
                page.items.map((item) => item.kind),
                ["skip", "run"],
            );
            const first = (await rig.invoke("schedules.runs", { name: "nightly", limit: 1 })) as {
                items: unknown[];
                cursor: string;
            };
            const second = (await rig.invoke("schedules.runs", {
                name: "nightly",
                limit: 1,
                cursor: first.cursor,
            })) as { items: unknown[]; cursor?: string };
            assert.deepEqual([...first.items, ...second.items], page.items);
            assert.equal(second.cursor, undefined);
            for (const input of [
                { name: "nightly", limit: 0 },
                { name: "nightly", limit: 501 },
                { name: "nightly", limit: 1.5 },
                { name: "nightly", cursor: "invalid" },
                { name: "nightly", cursor: "" },
            ]) {
                await assert.rejects(() => rig.invoke("schedules.runs", input), isRefusal("invalid_input"));
            }
            const listed = (await rig.invoke("schedules.list")) as {
                schedules: { latestScheduledRun?: { number: string } }[];
            };
            assert.equal(listed.schedules[0]?.latestScheduledRun?.number, job.number);
            assert.deepEqual(
                ((await rig.invoke("jobs.list", { schedule: "nightly" })) as { jobs: { number: string }[] }).jobs.map(
                    (item) => item.number,
                ),
                [job.number],
            );
            assert.deepEqual(
                ((await rig.invoke("jobs.list", { schedule: "missing" })) as { jobs: unknown[] }).jobs,
                [],
            );
            await rig.restart("");
            assert.deepEqual(await rig.invoke("schedules.runs", { name: "nightly" }), history);
            assert.deepEqual(((await rig.invoke("schedules.list")) as Listed).schedules, []);
            await assert.rejects(
                () => rig.invoke("schedules.runs", { name: "missing" }),
                isRefusal("not_found", "missing"),
            );
        } finally {
            await db.close();
        }
    });
});
