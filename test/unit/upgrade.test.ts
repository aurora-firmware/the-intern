import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { acquireOwnership, readOwnerLock } from "../../src/daemon/ownership.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../../src/daemon/state_layout.ts";
import { type PlatformFacts, UPGRADE_STEPS } from "../../src/install/install_model.ts";
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
import { markKept, takeCopy, upgradesDir } from "../../src/install/state_copy.ts";
import { askYesNo, resumeUpgrade, runUpgrade, type UpgradeInput } from "../../src/install/upgrade.ts";

const LINUX: PlatformFacts = { platform: "linux", arch: "x64", hasGlibc: true, hasSystemd: true, uid: 1000 };
const NOW = new Date("2026-03-04T05:06:07.000Z");

let home: string;
let layout: ProgramLayout;
let dirs: InstanceDirs;
let record: ServiceRecord;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "upgrade-"));
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
    database.exec("CREATE TABLE marker (id INTEGER)");
    database.close();
    await mkdir(layout.versionDir("1.0.0"), { recursive: true });
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

function capture(options: { isStdinTerminal?: boolean } = {}) {
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
        // The environment names other directories than the record: the command must act on the record's.
        env: { PATH: "/usr/bin", XDG_STATE_HOME: join(home, "other-state") },
        cwd: home,
        homeDir: home,
        isStdoutTerminal: false,
        isStdinTerminal: options.isStdinTerminal ?? false,
    } satisfies CommandIo;
    return { io, err: () => err };
}

function journalStepNow(): string | null | undefined {
    try {
        return (JSON.parse(readFileSync(layout.journal, "utf8")) as OperationJournal).lastStep;
    } catch {
        return undefined;
    }
}

function setup(options: { ready?: ReadyWaitResult; isStdinTerminal?: boolean } = {}) {
    const io = capture({ isStdinTerminal: options.isStdinTerminal });
    const events: string[] = [];
    const manager: ServiceManager = {
        async register() {},
        async remove() {},
        async stop() {
            events.push(`stop (journal at ${journalStepNow()}, held ${existsSyncHold()})`);
        },
        async start() {
            events.push(`start (journal at ${journalStepNow()}, held ${existsSyncHold()})`);
        },
        async state() {
            return { registered: true, startsAtBoot: true };
        },
        logCommand: () => "journalctl",
    };
    const waited: ServiceRecord[] = [];
    const context: ServiceCommandContext = {
        io: io.io,
        layout,
        facts: LINUX,
        managerFor: () => manager,
        resumers: {
            upgrade: async (journal) => resumeUpgrade(context, journal),
            "switch-back": async () => {},
            "fresh-start": async () => {},
            rollback: async () => {},
        },
        waitForReady: async (waitedRecord) => {
            waited.push(waitedRecord);
            events.push(`wait (journal at ${journalStepNow()})`);
            return options.ready ?? { ready: true, version: "1.1.0" };
        },
        readVersion: async () => null,
        versionTimeoutMs: 1000,
    };
    const fetched: string[] = [];
    const recorded: (string | null | undefined)[] = [];
    // Reading the variable runs once after every journal write, so the getter sees each recorded step.
    const stepIo: StepIo = {
        env: Object.defineProperty({}, "BOB_INSTALL_TEST_STOP_AFTER", {
            get() {
                recorded.push(journalStepNow());
                return undefined;
            },
        }),
        writeError: () => {},
        waitForResume: async () => {},
    };
    const release = {
        latest: async () => "1.1.0",
        fetch: async (version: string, platform: string) => {
            fetched.push(`${version} ${platform}`);
            await mkdir(layout.versionDir(version), { recursive: true });
            return layout.versionDir(version);
        },
    };
    const input = (overrides: Partial<UpgradeInput> = {}): UpgradeInput => ({
        context,
        version: undefined,
        yes: true,
        release,
        ask: async () => true,
        now: () => NOW,
        stepIo,
        ...overrides,
    });
    return { context, io, events, waited, fetched, recorded, stepIo, input };
}

function existsSyncHold(): boolean {
    try {
        readFileSync(layout.holdFile);
        return true;
    } catch {
        return false;
    }
}

describe("bob upgrade refusals", () => {
    it("exits 1 naming --yes when there is no terminal and no --yes, changing nothing", async () => {
        const { io, events, fetched, input } = setup();

        const status = await runUpgrade(input({ yes: false }));

        assert.equal(status, 1);
        assert.match(io.err(), /--yes/);
        assert.deepEqual(events, []);
        assert.deepEqual(fetched, []);
        assert.equal(await readLink(layout, "current"), "1.0.0");
        assert.equal(await exists(layout.journal), false);
    });

    it("exits 1 and removes what it downloaded when the team member answers no", async () => {
        const { io, events, input } = setup({ isStdinTerminal: true });
        const questions: string[] = [];

        const status = await runUpgrade(
            input({
                yes: false,
                ask: async (question) => {
                    questions.push(question);
                    return false;
                },
            }),
        );

        assert.equal(status, 1);
        assert.deepEqual(questions, ["Stop the service and upgrade from 1.0.0 to 1.1.0?"]);
        assert.match(io.err(), /nothing was changed/i);
        assert.deepEqual(events, []);
        assert.equal(await readLink(layout, "current"), "1.0.0");
        assert.equal(await readLink(layout, "previous"), null);
        assert.equal(await exists(layout.versionDir("1.1.0")), false);
        assert.equal(await exists(layout.journal), false);
        assert.equal(await exists(upgradesDir(dirs.stateDir)), false);
    });

    it("exits 1 when no service is registered", async () => {
        const { io, input } = setup();
        await rm(layout.serviceRecord);

        assert.equal(await runUpgrade(input()), 1);
        assert.match(io.err(), /not registered/);
    });

    it("exits 1 when a daemon the service didn't start owns the instance", async () => {
        const { io, events, input } = setup();
        const foreign = await acquireOwnership(dirs.stateDir);

        try {
            assert.equal(await runUpgrade(input()), 1);
        } finally {
            await foreign.release();
        }

        assert.match(io.err(), /the service didn't start/);
        assert.deepEqual(events, []);
    });

    it("exits 1 for an older version", async () => {
        const { io, input } = setup();

        assert.equal(await runUpgrade(input({ version: "0.9.0" })), 1);
        assert.match(io.err(), /older/);
    });

    it("exits 1 for a version that is not of the form X.Y.Z", async () => {
        const { io, fetched, input } = setup();

        assert.equal(await runUpgrade(input({ version: "latest-ish" })), 1);
        assert.match(io.err(), /latest-ish/);
        assert.deepEqual(fetched, []);
    });

    it("exits 1 with the reason when the download is refused", async () => {
        const { io, input } = setup();
        const release = {
            latest: async () => "1.1.0",
            fetch: async () => {
                throw new Error("Checksum mismatch for the bundle");
            },
        };

        assert.equal(await runUpgrade(input({ release })), 1);
        assert.match(io.err(), /Checksum mismatch/);
        assert.equal(await exists(layout.journal), false);
    });
});

describe("bob upgrade when already on the version", () => {
    it("says so and exits 0 changing nothing", async () => {
        const { io, events, fetched, input } = setup();

        const status = await runUpgrade(input({ version: "1.0.0" }));

        assert.equal(status, 0);
        assert.match(io.err(), /already on version 1\.0\.0/i);
        assert.deepEqual(events, []);
        assert.deepEqual(fetched, []);
    });
});

describe("bob upgrade success", () => {
    it("records each step in order, switches the links and keeps only the new and kept copies", async () => {
        const { events, waited, fetched, recorded, input } = setup();
        const oldCopy = await takeCopy(dirs, "0.8.0", "0.9.0", new Date("2026-01-01T00:00:00.000Z"));
        const keptCopy = await takeCopy(dirs, "0.9.0", "1.0.0", new Date("2026-02-01T00:00:00.000Z"));
        await markKept(dirs, keptCopy);

        const status = await runUpgrade(input());

        assert.equal(status, 0);
        assert.deepEqual(fetched, ["1.1.0 linux-x64"]);
        assert.deepEqual(recorded, [...UPGRADE_STEPS]);
        assert.deepEqual(events, [
            "stop (journal at held, held true)",
            "start (journal at switched, held false)",
            "wait (journal at released)",
        ]);
        assert.deepEqual(waited, [record]);
        assert.equal(await readLink(layout, "previous"), "1.0.0");
        assert.equal(await readLink(layout, "current"), "1.1.0");
        assert.equal(await exists(layout.journal), false);
        assert.equal(await exists(layout.holdFile), false);
        assert.equal(await readOwnerLock(dirs.stateDir), undefined);
        const folders = (await readdir(upgradesDir(dirs.stateDir))).sort();
        assert.equal(folders.includes(oldCopy), false);
        assert.deepEqual(folders.length, 2);
        assert.ok(folders.includes(keptCopy));
        assert.ok(folders.some((name) => name.endsWith("-1.0.0-to-1.1.0")));
    });

    it("upgrades to the version asked for, not the latest", async () => {
        const { fetched, input } = setup();

        assert.equal(await runUpgrade(input({ version: "1.2.0" })), 0);

        assert.deepEqual(fetched, ["1.2.0 linux-x64"]);
        assert.equal(await readLink(layout, "current"), "1.2.0");
    });

    it("uses a version folder that is already installed instead of downloading it again", async () => {
        const { fetched, input } = setup();
        await mkdir(layout.versionDir("1.1.0"), { recursive: true });

        assert.equal(await runUpgrade(input()), 0);

        assert.deepEqual(fetched, []);
        assert.equal(await readLink(layout, "current"), "1.1.0");
    });

    it("exits 1 with the reason and leaves the journal when the new version is not ready", async () => {
        const { io, input } = setup({ ready: { ready: false, report: undefined } });

        assert.equal(await runUpgrade(input()), 1);

        assert.match(io.err(), /ready/);
        assert.equal((await readJournal(layout))?.lastStep, "released");
    });

    it("prints each step as it runs on standard error", async () => {
        const { io, input } = setup();

        await runUpgrade(input());

        const steps = io.err().split("\n");
        assert.ok(steps.some((line) => /hold/i.test(line)));
        assert.ok(steps.some((line) => /ready/i.test(line)));
    });
});

function cutOffJournal(lastStep: string | null, to = "1.1.0"): OperationJournal {
    return {
        format: 1,
        operation: "upgrade",
        from: "1.0.0",
        to,
        copyName: null,
        setAsideName: null,
        currentBefore: "1.0.0",
        previousBefore: null,
        lastStep,
    };
}

describe("resuming a cut-off upgrade", () => {
    it("continues from the step after lastStep", async () => {
        const { context, events, recorded, stepIo } = setup();
        await mkdir(layout.versionDir("1.1.0"), { recursive: true });
        await hold(layout);
        const journal = cutOffJournal("stopped");
        await writeJournal(layout, journal);

        await resumeUpgrade(context, journal, { now: () => NOW, stepIo });

        assert.deepEqual(recorded, ["owned", "copied", "switched", "released", "ready"]);
        assert.deepEqual(events, ["start (journal at switched, held false)", "wait (journal at released)"]);
        assert.equal(await readLink(layout, "current"), "1.1.0");
        assert.equal(await readLink(layout, "previous"), "1.0.0");
        assert.equal(await exists(layout.journal), false);
        assert.equal((await readdir(upgradesDir(dirs.stateDir))).length, 1);
    });

    it("finishes only the wait when the cut-off came after the release", async () => {
        const { context, events, recorded, stepIo } = setup();
        await mkdir(layout.versionDir("1.1.0"), { recursive: true });
        await switchLink(layout, "previous", "1.0.0");
        await switchLink(layout, "current", "1.1.0");
        const journal = { ...cutOffJournal("released"), copyName: "the-copy" };
        await writeJournal(layout, journal);

        await resumeUpgrade(context, journal, { now: () => NOW, stepIo });

        assert.deepEqual(recorded, ["ready"]);
        assert.deepEqual(events, ["wait (journal at released)"]);
        assert.equal(await exists(layout.journal), false);
    });

    it("refuses with the reason when the resumed upgrade is not ready", async () => {
        const { context } = setup({ ready: { ready: false, report: undefined } });
        const journal = { ...cutOffJournal("released"), copyName: "the-copy" };
        await writeJournal(layout, journal);

        await assert.rejects(resumeUpgrade(context, journal), /ready/);
        assert.equal((await readJournal(layout))?.lastStep, "released");
    });
});

describe("bob upgrade finding a cut-off upgrade", () => {
    it("finishes an upgrade to the asked version and exits 0 without deciding already on", async () => {
        const { io, fetched, events, input } = setup();
        await mkdir(layout.versionDir("1.1.0"), { recursive: true });
        await hold(layout);
        await writeJournal(layout, cutOffJournal("stopped"));

        const status = await runUpgrade(input({ version: "1.1.0" }));

        assert.equal(status, 0);
        assert.doesNotMatch(io.err(), /already on/i);
        assert.deepEqual(fetched, []);
        assert.equal(events.filter((event) => event.startsWith("start")).length, 1);
        assert.equal(await readLink(layout, "current"), "1.1.0");
        assert.equal(await exists(layout.journal), false);
    });

    it("exits 1 as that upgrade ends when it is not ready", async () => {
        const { input } = setup({ ready: { ready: false, report: undefined } });
        await mkdir(layout.versionDir("1.1.0"), { recursive: true });
        await writeJournal(layout, cutOffJournal("released"));

        assert.equal(await runUpgrade(input({ version: "1.1.0" })), 1);
    });

    it("finishes an upgrade to another version first, then decides this one as usual", async () => {
        const { fetched, input } = setup();
        await mkdir(layout.versionDir("1.1.0"), { recursive: true });
        await switchLink(layout, "previous", "1.0.0");
        await switchLink(layout, "current", "1.1.0");
        await writeJournal(layout, cutOffJournal("released", "1.1.0"));

        const status = await runUpgrade(input({ version: "1.2.0" }));

        assert.equal(status, 0);
        assert.deepEqual(fetched, ["1.2.0 linux-x64"]);
        assert.equal(await readLink(layout, "current"), "1.2.0");
        assert.equal(await readLink(layout, "previous"), "1.1.0");
    });
});

describe("asking the team member", () => {
    async function answer(text: string | null): Promise<boolean> {
        const stdin = new PassThrough();
        const { io } = capture({ isStdinTerminal: true });
        const asked = askYesNo({ ...io, stdin }, "Go on?");
        if (text === null) stdin.end();
        else stdin.write(text);
        return asked;
    }

    it("accepts y and yes in any case", async () => {
        assert.equal(await answer("y\n"), true);
        assert.equal(await answer("YES\n"), true);
    });

    it("counts anything else, an empty line and a closed input as no", async () => {
        assert.equal(await answer("n\n"), false);
        assert.equal(await answer("\n"), false);
        assert.equal(await answer("maybe\n"), false);
        assert.equal(await answer(null), false);
    });
});
