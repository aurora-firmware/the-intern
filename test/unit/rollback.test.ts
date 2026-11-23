import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../../src/daemon/state_layout.ts";
import { type PlatformFacts, ROLLBACK_STEPS } from "../../src/install/install_model.ts";
import { type OperationJournal, type StepIo, writeJournal } from "../../src/install/operation_journal.ts";
import { type ProgramLayout, programLayout, readLink, switchLink } from "../../src/install/program_layout.ts";
import { resumeRollback, runRollback } from "../../src/install/rollback.ts";
import type { ServiceCommandContext } from "../../src/install/service_commands.ts";
import {
    type ServiceManager,
    type ServiceRecord,
    writeServiceRecord,
} from "../../src/install/service_manager.ts";
import { takeCopy, upgradesDir } from "../../src/install/state_copy.ts";

const LINUX: PlatformFacts = { platform: "linux", arch: "x64", hasGlibc: true, hasSystemd: true, uid: 1000 };
const NOW = new Date("2026-03-04T05:06:07.000Z");
const COPY_TIME = new Date("2026-01-02T03:04:05.000Z");

let home: string;
let layout: ProgramLayout;
let dirs: InstanceDirs;
let record: ServiceRecord;

/** A version whose `bin/bob import` copies the database file it is given into the state directory. */
const FAKE_BOB = `#!/bin/sh
echo "$BOB_OWNER_LOCK_TOKEN" > "$3/import-token"
cp "$4" "$3/the-intern.sqlite"
`;

async function installFakeVersion(version: string): Promise<void> {
    await mkdir(join(layout.versionDir(version), "bin"), { recursive: true });
    await writeFile(join(layout.versionDir(version), "bin", "bob"), FAKE_BOB);
    await chmod(join(layout.versionDir(version), "bin", "bob"), 0o755);
}

function tablesOf(file: string): string[] {
    const database = new DatabaseSync(file);
    try {
        return (
            database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
        ).map((row) => row.name);
    } finally {
        database.close();
    }
}

function createTable(file: string, name: string): void {
    const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE ${name} (id INTEGER)`);
    database.close();
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

/** The state of an instance upgraded from 0.0.9 to 0.1.0, with the database, files and copy that went with it. */
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "rollback-"));
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
    createTable(dirs.databaseFile, "before_upgrade");
    await writeFile(dirs.configFile, "setting = 1\n");
    await mkdir(join(dirs.dataDir, "instructions"), { recursive: true });
    await writeFile(join(dirs.dataDir, "instructions", "a.md"), "old instructions");
    await installFakeVersion("0.0.9");
    await installFakeVersion("0.1.0");
    await takeCopy(dirs, "0.0.9", "0.1.0", COPY_TIME);
    createTable(dirs.databaseFile, "after_upgrade");
    await writeFile(dirs.configFile, "setting = 2\n");
    await writeFile(join(dirs.dataDir, "instructions", "a.md"), "new instructions");
    await switchLink(layout, "previous", "0.0.9");
    await switchLink(layout, "current", "0.1.0");
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

function setup(options: { isStdinTerminal?: boolean } = {}) {
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
    const manager: ServiceManager = {
        async register() {},
        async remove() {},
        async stop() {
            events.push("stop");
        },
        async start() {
            events.push(`start ${await readLink(layout, "current")}`);
        },
        async state() {
            return { registered: true, startsAtBoot: true };
        },
        logCommand: () => "journalctl",
    };
    const recordedSteps: (string | null)[] = [];
    const cutOffAfter: { step: string | null } = { step: null };
    // The step hook reads the variable after each step is journaled: the proxy notes the journal's lastStep then.
    const env = new Proxy({} as NodeJS.ProcessEnv, {
        get(_target, name) {
            if (name !== "BOB_INSTALL_TEST_STOP_AFTER") return undefined;
            const lastStep = (JSON.parse(readFileSync(layout.journal, "utf8")) as OperationJournal).lastStep;
            recordedSteps.push(lastStep);
            return lastStep === cutOffAfter.step ? lastStep : undefined;
        },
    });
    const stepIo: StepIo = {
        env,
        writeError: () => {},
        waitForResume: async () => {
            throw new Error("the process was cut off");
        },
    };
    const context: ServiceCommandContext = {
        io,
        layout,
        facts: LINUX,
        managerFor: () => manager,
        resumers: {
            upgrade: async () => {},
            "switch-back": async () => {},
            "fresh-start": async () => {},
            rollback: async (journal) => resumeRollback(context, journal, { now: () => NOW, stepIo }),
        },
        waitForReady: async () => ({ ready: true, version: "0.0.9" }),
        readVersion: async () => null,
        versionTimeoutMs: 1000,
    };
    const questions: { question: string; defaultYes: boolean }[] = [];
    const input = (answer: boolean | "never", overrides: { yes?: boolean } = {}) => ({
        context,
        yes: true,
        ask: async (question: string, defaultYes: boolean) => {
            questions.push({ question, defaultYes });
            if (answer === "never") throw new Error(`asked: ${question}`);
            return answer;
        },
        now: () => NOW,
        stepIo,
        ...overrides,
    });
    return { context, events, err: () => err, questions, input, recordedSteps, cutOffAfter };
}

async function expectNothingChanged(): Promise<void> {
    assert.equal(await readLink(layout, "current"), "0.1.0");
    assert.equal(await readLink(layout, "previous"), "0.0.9");
    assert.ok(tablesOf(dirs.databaseFile).includes("after_upgrade"));
    assert.equal(await readFile(dirs.configFile, "utf8"), "setting = 2\n");
    assert.equal(await exists(layout.journal), false);
    assert.equal(await exists(layout.holdFile), false);
}

describe("the warning of bob rollback", () => {
    it("names the previous version, the copy's time, what is lost and the work and mail that may repeat", async () => {
        const { err, input } = setup({ isStdinTerminal: true });

        await runRollback(input(false, { yes: false }));

        const text = err();
        assert.match(text, /0\.0\.9/);
        assert.match(text, /2026-01-02T03:04:05\.000Z/);
        assert.match(text, /jobs and conversations/);
        assert.match(text, /configuration, roles, instructions and skills/);
        assert.match(text, /mail accounts added since/);
        assert.match(text, /work in progress at the upgrade may run again/);
        assert.match(text, /mail received since may be taken in again/);
        assert.match(text, /mail sent since may be sent again/);
    });

    it("is given with --yes too, and nothing is asked", async () => {
        const { err, questions, input } = setup();

        assert.equal(await runRollback(input("never")), 0);

        assert.match(err(), /everything done since then will be lost/i);
        assert.deepEqual(questions, []);
    });
});

describe("bob rollback when the team member answers no", () => {
    it("exits 1 with nothing changed", async () => {
        const { err, events, questions, input } = setup({ isStdinTerminal: true });

        assert.equal(await runRollback(input(false, { yes: false })), 1);

        assert.equal(questions.length, 1);
        assert.match(err(), /declined; nothing was changed/);
        assert.deepEqual(events, []);
        await expectNothingChanged();
    });
});

describe("the refusals of bob rollback", () => {
    it("refuses without a previous version and changes nothing", async () => {
        await switchLink(layout, "previous", null);
        const { err, events, input } = setup();

        assert.equal(await runRollback(input("never")), 1);

        assert.match(err(), /no previous version/);
        assert.deepEqual(events, []);
        assert.equal(await readLink(layout, "current"), "0.1.0");
        assert.equal(await exists(layout.journal), false);
    });

    it("refuses without a terminal or --yes and changes nothing", async () => {
        const { err, events, input } = setup();

        assert.equal(await runRollback(input("never", { yes: false })), 1);

        assert.match(err(), /give --yes/);
        assert.deepEqual(events, []);
        await expectNothingChanged();
    });
});

describe("a completed bob rollback", () => {
    it("records each step in order, returns to the previous version and leaves no previous link or left version", async () => {
        const { events, input, recordedSteps } = setup();

        assert.equal(await runRollback(input("never")), 0);

        assert.deepEqual(recordedSteps, [...ROLLBACK_STEPS]);
        assert.equal(await readLink(layout, "current"), "0.0.9");
        assert.equal(await readLink(layout, "previous"), null);
        assert.equal(await exists(layout.versionDir("0.1.0")), false);
        assert.deepEqual(events, ["stop", "start 0.0.9"]);
        assert.equal(await exists(layout.journal), false);
        assert.equal(await exists(layout.holdFile), false);
    });

    it("sets the database aside, imports the copy and puts back the configuration and the internal folder", async () => {
        const { input } = setup();

        assert.equal(await runRollback(input("never")), 0);

        const tables = tablesOf(dirs.databaseFile);
        assert.ok(tables.includes("before_upgrade"));
        assert.equal(tables.includes("after_upgrade"), false);
        assert.match(await readFile(join(dirs.stateDir, "import-token"), "utf8"), /\S/);
        const aside = (await readdir(upgradesDir(dirs.stateDir))).filter((name) => name.endsWith("-0.1.0-rollback"));
        assert.equal(aside.length, 1);
        assert.equal(await readFile(dirs.configFile, "utf8"), "setting = 1\n");
        assert.equal(await readFile(join(dirs.dataDir, "instructions", "a.md"), "utf8"), "old instructions");
    });

    it("exits 1 naming the reason when the previous version isn't ready, leaving the rollback unfinished", async () => {
        const { context, err, input } = setup();
        context.waitForReady = async () => ({ ready: false, report: undefined });

        assert.equal(await runRollback(input("never")), 1);

        assert.match(err(), /isn't ready after the rollback/);
        assert.equal(await exists(layout.journal), true);
    });
});

describe("bob rollback after an upgrade that failed and switched back", () => {
    it("uses the copy of the earlier upgrade, not the failed attempt's newer one, and returns to 0.0.9", async () => {
        await takeCopy(dirs, "0.1.0", "0.2.0", new Date("2026-02-02T00:00:00.000Z"));
        const { err, input } = setup();

        assert.equal(await runRollback(input("never")), 0);

        assert.match(err(), /2026-01-02T03:04:05\.000Z/);
        assert.equal(await readLink(layout, "current"), "0.0.9");
        assert.ok(tablesOf(dirs.databaseFile).includes("before_upgrade"));
    });
});

describe("bob rollback that finds a cut-off rollback", () => {
    it("finishes it from the step after the last one done and exits 0", async () => {
        const first = setup();
        first.cutOffAfter.step = "switched";
        await assert.rejects(runRollback(first.input("never")), /cut off/);
        const { events, err, input } = setup();

        assert.equal(await runRollback(input("never", { yes: false })), 0);

        assert.deepEqual(first.events, ["stop"]);
        assert.deepEqual(events, ["start 0.0.9"]);
        assert.equal(await readLink(layout, "current"), "0.0.9");
        assert.equal(await readLink(layout, "previous"), null);
        assert.equal(await exists(layout.versionDir("0.1.0")), false);
        assert.equal(await exists(layout.journal), false);
        assert.doesNotMatch(err(), /no previous version/);
    });

    it("finishes one whose previous link is already gone, without refusing for lack of a previous version", async () => {
        await switchLink(layout, "current", "0.0.9");
        await switchLink(layout, "previous", null);
        await writeJournal(layout, {
            format: 1,
            operation: "rollback",
            from: "0.0.9",
            to: "0.1.0",
            copyName: null,
            setAsideName: null,
            currentBefore: "0.1.0",
            previousBefore: "0.0.9",
            lastStep: "ready",
        });
        const { err, input } = setup();

        assert.equal(await runRollback(input("never", { yes: false })), 0);

        assert.doesNotMatch(err(), /no previous version/);
        assert.equal(await exists(layout.versionDir("0.1.0")), false);
        assert.equal(await exists(layout.journal), false);
    });
});
