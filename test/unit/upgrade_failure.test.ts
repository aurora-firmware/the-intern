import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { readOwnerLock } from "../../src/daemon/ownership.ts";
import { type StartupReport, writeStartupReport } from "../../src/daemon/startup_report.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../../src/daemon/state_layout.ts";
import type { PlatformFacts } from "../../src/install/install_model.ts";
import { type OperationJournal, readJournal, type StepIo, writeJournal } from "../../src/install/operation_journal.ts";
import { type ProgramLayout, programLayout, readLink, switchLink } from "../../src/install/program_layout.ts";
import type { ReadyWaitResult } from "../../src/install/ready_wait.ts";
import type { ServiceCommandContext } from "../../src/install/service_commands.ts";
import {
    hold,
    type ServiceManager,
    type ServiceRecord,
    writeServiceRecord,
} from "../../src/install/service_manager.ts";
import { copyFor, readCopyInfo, takeCopy, upgradesDir } from "../../src/install/state_copy.ts";
import {
    resumeFreshStart,
    resumeSwitchBack,
    resumeUpgrade,
    runUpgrade,
    type UpgradeInput,
} from "../../src/install/upgrade.ts";

const LINUX: PlatformFacts = { platform: "linux", arch: "x64", hasGlibc: true, hasSystemd: true, uid: 1000 };
const NOW = new Date("2026-03-04T05:06:07.000Z");

let home: string;
let layout: ProgramLayout;
let dirs: InstanceDirs;
let record: ServiceRecord;

/** A previous version whose `bin/bob import` copies the database file it is given into the state directory. */
const FAKE_BOB = `#!/bin/sh
echo "$BOB_OWNER_LOCK_TOKEN" > "$3/import-token"
cp "$4" "$3/the-intern.sqlite"
`;

async function installFakeVersion(version: string): Promise<void> {
    await mkdir(join(layout.versionDir(version), "bin"), { recursive: true });
    await writeFile(join(layout.versionDir(version), "bin", "bob"), FAKE_BOB);
    await chmod(join(layout.versionDir(version), "bin", "bob"), 0o755);
}

function markerTables(file: string): string[] {
    const database = new DatabaseSync(file);
    try {
        return (
            database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
        ).map((row) => row.name);
    } finally {
        database.close();
    }
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "upgrade-failure-"));
    layout = programLayout(home);
    dirs = resolveInstanceDirs({
        flags: {
            configDir: join(home, "inst", "config"),
            stateDir: join(home, "inst", "state"),
            dataDir: join(home, "inst", "data"),
            runtimeDir: join(home, "inst", "run"),
        },
        env: {},
        homeDir: home,
    });
    for (const dir of [dirs.configDir, dirs.stateDir, dirs.dataDir, dirs.runtimeDir]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const database = new DatabaseSync(dirs.databaseFile);
    database.exec("CREATE TABLE before_upgrade (id INTEGER)");
    database.close();
    await writeFile(dirs.configFile, "setting = 1\n");
    await mkdir(join(dirs.dataDir, "instructions"), { recursive: true });
    await writeFile(join(dirs.dataDir, "instructions", "a.md"), "old instructions");
    await installFakeVersion("1.0.0");
    await switchLink(layout, "current", "1.0.0");
    record = {
        format: 1,
        platform: "linux-x64",
        label: "the-intern.service",
        configDir: dirs.configDir,
        stateDir: dirs.stateDir,
        dataDir: dirs.dataDir,
        runtimeDir: dirs.runtimeDir,
        piAgentDir: join(home, "pi"),
        path: "/usr/bin",
        lingerTurnedOn: true,
    };
    await writeServiceRecord(layout, record);
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

function report(overrides: Partial<StartupReport>): StartupReport {
    return {
        format: 1,
        version: "1.1.0",
        pid: 4242,
        serviceLabel: "the-intern.service",
        furthestStep: 2,
        failedStep: 2,
        failedStepName: "config",
        reason: "the web port is taken",
        unreadableDatabase: false,
        ready: false,
        ...overrides,
    };
}

type Outcome = { ready: boolean; report?: StartupReport };

/**
 * The new version starts first and fails as `newVersion` says, changing the configuration file and the internal folder
 * as a starting version may; every later wait finds `previousReady`.
 */
function setup(options: { newVersion: Outcome | "throws"; isStdinTerminal?: boolean; previousReady?: boolean }) {
    let err = "";
    const sink = (append: (text: string) => void) =>
        new Writable({
            write(chunk, _encoding, done) {
                append(String(chunk));
                done();
            },
        });
    const io = {
        stdout: sink(() => {}),
        stderr: sink((text) => {
            err += text;
        }),
        stdin: process.stdin,
        env: { PATH: "/usr/bin" },
        cwd: home,
        homeDir: home,
        isStdoutTerminal: false,
        isStdinTerminal: options.isStdinTerminal ?? false,
    } satisfies CommandIo;
    const events: string[] = [];
    let starts = 0;
    const manager: ServiceManager = {
        async register() {},
        async remove() {},
        async stop() {
            events.push("stop");
        },
        async start() {
            starts += 1;
            events.push(`start ${await readLink(layout, "current")}`);
            if (starts === 1 && (await readLink(layout, "current")) === "1.1.0") {
                if (options.newVersion === "throws") await writeFile(join(dirs.stateDir, "startup.json"), "{broken");
                else if (options.newVersion.report !== undefined) {
                    await writeStartupReport(dirs.stateDir, options.newVersion.report);
                }
                await writeFile(dirs.configFile, "setting = 2\n");
                await writeFile(join(dirs.dataDir, "instructions", "a.md"), "new instructions");
                const database = new DatabaseSync(dirs.databaseFile);
                database.exec("CREATE TABLE after_upgrade (id INTEGER)");
                database.close();
            }
        },
        async state() {
            return { registered: true, startsAtBoot: true };
        },
        logCommand: () => "journalctl",
    };
    let waits = 0;
    const context: ServiceCommandContext = {
        io,
        layout,
        facts: LINUX,
        managerFor: () => manager,
        resumers: {
            upgrade: async (journal) => resumeUpgrade(context, journal, { now: () => NOW, stepIo }),
            "switch-back": async (journal) => resumeSwitchBack(context, journal, { now: () => NOW, stepIo }),
            "fresh-start": async (journal) => resumeFreshStart(context, journal, { now: () => NOW, stepIo }),
            rollback: async () => {},
        },
        waitForReady: async (): Promise<ReadyWaitResult> => {
            waits += 1;
            events.push("wait");
            if (waits > 1) {
                return options.previousReady === false
                    ? { ready: false, report: undefined }
                    : { ready: true, version: "1.0.0" };
            }
            if (options.newVersion === "throws") throw new Error("startup.json is corrupt");
            return options.newVersion.ready
                ? { ready: true, version: "1.1.0" }
                : { ready: false, report: options.newVersion.report };
        },
        readVersion: async () => null,
        versionTimeoutMs: 1000,
    };
    const recorded: string[] = [];
    const stepIo: StepIo = {
        env: {},
        writeError: (text) => recorded.push(text.trim()),
        waitForResume: async () => {},
    };
    const questions: { question: string; defaultYes: boolean }[] = [];
    const input = (answer: boolean | "never", overrides: Partial<UpgradeInput> = {}): UpgradeInput => ({
        context,
        version: undefined,
        yes: true,
        release: {
            latest: async () => "1.1.0",
            fetch: async (version) => {
                await installFakeVersion(version);
                return layout.versionDir(version);
            },
        },
        ask: async (question, defaultYes) => {
            questions.push({ question, defaultYes });
            if (answer === "never") throw new Error(`asked: ${question}`);
            return answer;
        },
        now: () => NOW,
        stepIo,
        ...overrides,
    });
    return { context, events, err: () => err, questions, input, stepIo };
}

async function folders(): Promise<string[]> {
    return (await readdir(upgradesDir(dirs.stateDir))).sort();
}

async function expectPreviousVersionRestored(): Promise<void> {
    assert.equal(await readLink(layout, "current"), "1.0.0");
    assert.equal(await readFile(dirs.configFile, "utf8"), "setting = 1\n");
    assert.equal(await readFile(join(dirs.dataDir, "instructions", "a.md"), "utf8"), "old instructions");
    assert.equal(await exists(layout.versionDir("1.1.0")), false);
    assert.equal(await exists(layout.journal), false);
    assert.equal(await exists(layout.holdFile), false);
    assert.equal(await readOwnerLock(dirs.stateDir), undefined);
}

describe("bob upgrade when the new version fails for another reason", () => {
    it("switches back without asking, restores the files, removes the failed version and exits 1 naming the reason", async () => {
        const { err, events, questions, input } = setup({
            newVersion: { ready: false, report: report({ furthestStep: 2 }) },
        });

        const status = await runUpgrade(input("never"));

        assert.equal(status, 1);
        assert.match(err(), /the web port is taken/);
        assert.deepEqual(questions, []);
        assert.deepEqual(events, ["stop", "start 1.1.0", "wait", "stop", "start 1.0.0", "wait"]);
        await expectPreviousVersionRestored();
        assert.equal(await readLink(layout, "previous"), null);
    });

    it("leaves the database alone when the new version didn't get as far as opening it", async () => {
        const { input } = setup({ newVersion: { ready: false, report: report({ furthestStep: 3 }) } });

        await runUpgrade(input("never"));

        assert.ok(markerTables(dirs.databaseFile).includes("after_upgrade"));
        assert.equal(await exists(join(dirs.stateDir, "import-token")), false);
        assert.deepEqual(
            (await folders()).filter((name) => name.endsWith("failed-upgrade")),
            [],
        );
    });

    it("treats a missing startup report as a failure before the database", async () => {
        const { err, input } = setup({ newVersion: { ready: false, report: undefined } });

        assert.equal(await runUpgrade(input("never")), 1);
        assert.match(err(), /wrote no startup report/);
        await expectPreviousVersionRestored();
    });
});

describe("bob upgrade when the new version fails after opening the database", () => {
    it("sets the database aside and imports the copy with the previous version's import step", async () => {
        const { input } = setup({ newVersion: { ready: false, report: report({ furthestStep: 4 }) } });

        assert.equal(await runUpgrade(input("never")), 1);

        const aside = (await folders()).filter((name) => name.endsWith("-1.1.0-failed-upgrade"));
        assert.equal(aside.length, 1);
        assert.ok(
            markerTables(join(upgradesDir(dirs.stateDir), aside[0], "the-intern.sqlite")).includes("after_upgrade"),
        );
        const tables = markerTables(dirs.databaseFile);
        assert.ok(tables.includes("before_upgrade"));
        assert.equal(tables.includes("after_upgrade"), false);
        assert.match(await readFile(join(dirs.stateDir, "import-token"), "utf8"), /\S/);
        await expectPreviousVersionRestored();
    });

    it("assumes the database was opened when the startup report can't be read", async () => {
        const { err, input } = setup({ newVersion: "throws" });

        assert.equal(await runUpgrade(input("never")), 1);

        assert.match(err(), /startup\.json is corrupt/);
        assert.equal(markerTables(dirs.databaseFile).includes("after_upgrade"), false);
        await expectPreviousVersionRestored();
    });
});

describe("the links and copies after a switch-back", () => {
    it("names the version previous named before and keeps every copy, the earlier upgrade's among them", async () => {
        await installFakeVersion("0.9.0");
        await switchLink(layout, "previous", "0.9.0");
        const earlier = await takeCopy(dirs, "0.9.0", "1.0.0", new Date("2026-01-01T00:00:00.000Z"));
        const { input } = setup({ newVersion: { ready: false, report: report({ furthestStep: 4 }) } });

        assert.equal(await runUpgrade(input("never")), 1);

        assert.equal(await readLink(layout, "previous"), "0.9.0");
        assert.equal(await readLink(layout, "current"), "1.0.0");
        const names = await folders();
        assert.ok(names.includes(earlier));
        assert.ok(names.some((name) => name.endsWith("-1.0.0-to-1.1.0")));
        assert.equal(await copyFor(dirs, "0.9.0", "1.0.0"), earlier);
    });
});

describe("bob upgrade when the database is unreadable", () => {
    const unreadable = report({ furthestStep: 4, unreadableDatabase: true, reason: "the job schema is newer" });

    it("says so and asks Switch back to 1.0.0 with yes the default, then switches back on yes", async () => {
        const { err, questions, input } = setup({
            newVersion: { ready: false, report: unreadable },
            isStdinTerminal: true,
        });

        assert.equal(await runUpgrade(input(true)), 1);

        assert.deepEqual(questions, [{ question: "Switch back to 1.0.0?", defaultYes: true }]);
        assert.match(err(), /the job schema is newer/);
        await expectPreviousVersionRestored();
    });

    it("switches back without asking when standard input isn't a terminal", async () => {
        const { questions, input } = setup({ newVersion: { ready: false, report: unreadable } });

        assert.equal(await runUpgrade(input("never")), 1);

        assert.deepEqual(questions, []);
        await expectPreviousVersionRestored();
    });

    it("starts the new version on a new database and keeps the copy and the set-aside database on no", async () => {
        const { err, events, input } = setup({
            newVersion: { ready: false, report: unreadable },
            isStdinTerminal: true,
        });

        assert.equal(await runUpgrade(input(false)), 0);

        assert.equal(await readLink(layout, "current"), "1.1.0");
        assert.equal(await readLink(layout, "previous"), "1.0.0");
        assert.equal(await readFile(dirs.configFile, "utf8"), "setting = 2\n");
        assert.equal(await readFile(join(dirs.dataDir, "instructions", "a.md"), "utf8"), "new instructions");
        assert.equal(await exists(dirs.databaseFile), false);
        const names = await folders();
        const aside = names.find((name) => name.endsWith("-1.1.0-unreadable")) as string;
        const copy = names.find((name) => name.endsWith("-1.0.0-to-1.1.0")) as string;
        assert.ok(aside && copy);
        assert.equal((await readCopyInfo(dirs, copy)).kept, true);
        assert.ok(err().includes(join(upgradesDir(dirs.stateDir), aside)));
        assert.ok(err().includes(join(upgradesDir(dirs.stateDir), copy)));
        assert.deepEqual(events, ["stop", "start 1.1.0", "wait", "stop", "start 1.1.0", "wait"]);
        assert.equal(await exists(layout.journal), false);
        assert.equal(await exists(layout.holdFile), false);
    });

    it("exits 1 when the new version isn't ready after the fresh start", async () => {
        const { input } = setup({
            newVersion: { ready: false, report: unreadable },
            isStdinTerminal: true,
            previousReady: false,
        });

        assert.equal(await runUpgrade(input(false)), 1);
        assert.equal((await readJournal(layout))?.operation, "fresh-start");
    });
});

describe("bob upgrade when the previous version isn't ready after the switch-back", () => {
    it("exits 1 and leaves the switch-back's journal for the next command", async () => {
        const { err, input } = setup({
            newVersion: { ready: false, report: report({}) },
            previousReady: false,
        });

        assert.equal(await runUpgrade(input("never")), 1);

        assert.match(err(), /isn't ready/);
        const journal = await readJournal(layout);
        assert.equal(journal?.operation, "switch-back");
        assert.equal(journal?.lastStep, "released");
    });
});

function cutOff(operation: OperationJournal["operation"], lastStep: string, copyName: string): OperationJournal {
    return {
        format: 1,
        operation,
        from: "1.0.0",
        to: "1.1.0",
        copyName,
        setAsideName: null,
        currentBefore: "1.0.0",
        previousBefore: null,
        lastStep,
    };
}

describe("resuming a switch-back or a fresh start", () => {
    it("continues a switch-back from the step after lastStep", async () => {
        const { context, events, stepIo } = setup({ newVersion: { ready: true } });
        const copy = await takeCopy(dirs, "1.0.0", "1.1.0", NOW);
        await installFakeVersion("1.1.0");
        await switchLink(layout, "previous", "1.0.0");
        await switchLink(layout, "current", "1.1.0");
        await hold(layout);
        const journal = cutOff("switch-back", "owned", copy);
        await writeJournal(layout, journal);
        await writeFile(dirs.configFile, "setting = 2\n");

        await assert.rejects(resumeSwitchBack(context, journal, { now: () => NOW, stepIo }), /switched back/i);

        assert.deepEqual(events, ["start 1.0.0", "wait"]);
        assert.equal(await readLink(layout, "current"), "1.0.0");
        assert.equal(await readLink(layout, "previous"), null);
        assert.equal(await readFile(dirs.configFile, "utf8"), "setting = 1\n");
        assert.equal(await exists(layout.versionDir("1.1.0")), false);
        assert.equal(await exists(layout.journal), false);
    });

    it("finishes only the removal when the cut-off came after ready", async () => {
        const { context, events, stepIo } = setup({ newVersion: { ready: true } });
        const copy = await takeCopy(dirs, "1.0.0", "1.1.0", NOW);
        await installFakeVersion("1.1.0");
        const journal = cutOff("switch-back", "ready", copy);
        await writeJournal(layout, journal);

        await assert.rejects(resumeSwitchBack(context, journal, { now: () => NOW, stepIo }), /switched back/i);

        assert.deepEqual(events, []);
        assert.equal(await exists(layout.versionDir("1.1.0")), false);
        assert.equal(await exists(layout.journal), false);
    });

    it("continues a fresh start from the step after lastStep", async () => {
        const { context, err, events, stepIo } = setup({ newVersion: { ready: true } });
        const copy = await takeCopy(dirs, "1.0.0", "1.1.0", NOW);
        await installFakeVersion("1.1.0");
        await switchLink(layout, "previous", "1.0.0");
        await switchLink(layout, "current", "1.1.0");
        await hold(layout);
        const journal = { ...cutOff("fresh-start", "set-aside", copy), setAsideName: "the-aside" };
        await writeJournal(layout, journal);

        await resumeFreshStart(context, journal, { now: () => NOW, stepIo });

        assert.deepEqual(events, ["start 1.1.0", "wait"]);
        assert.equal((await readCopyInfo(dirs, copy)).kept, true);
        assert.ok(err().includes(join(upgradesDir(dirs.stateDir), "the-aside")));
        assert.equal(await exists(layout.journal), false);
    });
});
