import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandIo } from "../../src/cli/command_line.ts";
import type { PlatformFacts } from "../../src/install/install_model.ts";
import type { Resumers } from "../../src/install/operation_journal.ts";
import { type ProgramLayout, programLayout } from "../../src/install/program_layout.ts";
import type { ServiceCommandContext } from "../../src/install/service_commands.ts";
import {
    type CommandRunner,
    hold,
    type ServiceManager,
    type ServiceRecord,
    writeServiceRecord,
} from "../../src/install/service_manager.ts";
import { runUninstall } from "../../src/install/uninstall.ts";

const LINUX: PlatformFacts = { platform: "linux", arch: "x64", hasGlibc: true, hasSystemd: true, uid: 1000 };

const NO_RESUMERS: Resumers = {
    upgrade: async () => {},
    "switch-back": async () => {},
    "fresh-start": async () => {},
    rollback: async () => {},
};

let home: string;
let layout: ProgramLayout;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "uninstall-"));
    layout = programLayout(home);
    await mkdir(join(layout.versionDir("1.0.0"), "bin"), { recursive: true });
    await symlink(join("versions", "1.0.0"), layout.current);
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await symlink(join(layout.current, "bin", "bob"), layout.bobLink);
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
    return lstat(path).then(
        () => true,
        () => false,
    );
}

function capture(isStdinTerminal = false) {
    let out = "";
    let err = "";
    const sink = (append: (text: string) => void) =>
        new Writable({
            write(chunk, _encoding, done) {
                append(String(chunk));
                done();
            },
        });
    const io = {
        stdout: sink((text) => {
            out += text;
        }),
        stderr: sink((text) => {
            err += text;
        }),
        stdin: process.stdin,
        env: { PATH: "/usr/bin:/bin", XDG_STATE_HOME: join(home, "xdg-state"), PI_CODING_AGENT_DIR: join(home, "pi") },
        cwd: home,
        homeDir: home,
        isStdoutTerminal: false,
        isStdinTerminal,
    } satisfies CommandIo;
    return { io, out: () => out, err: () => err };
}

function fakeManager(calls: string[]): ServiceManager {
    return {
        register: async () => {},
        remove: async () => {
            calls.push("remove");
        },
        stop: async () => {
            calls.push("stop");
        },
        start: async () => {},
        state: async () => ({ registered: true, startsAtBoot: true }),
        logCommand: () => "journalctl",
    };
}

function recordOf(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
    return {
        format: 1,
        platform: "linux-x64",
        label: "the-intern.service",
        configDir: join(home, "i", "config"),
        stateDir: join(home, "i", "state"),
        dataDir: join(home, "i", "data"),
        runtimeDir: join(home, "i", "run"),
        piAgentDir: join(home, "pi"),
        path: "/usr/bin",
        lingerTurnedOn: false,
        ...overrides,
    };
}

async function makeInstance(record: ServiceRecord): Promise<void> {
    for (const dir of [record.configDir, record.stateDir, record.dataDir, record.runtimeDir, record.piAgentDir]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "file"), "x");
    }
    await mkdir(join(record.stateDir, "upgrades", "copy"), { recursive: true });
}

function setup(options: { isTerminal?: boolean } = {}) {
    const io = capture(options.isTerminal ?? false);
    const calls: string[] = [];
    const commands: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
        commands.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "" };
    };
    const context: ServiceCommandContext = {
        io: io.io,
        layout,
        facts: LINUX,
        managerFor: () => fakeManager(calls),
        resumers: NO_RESUMERS,
        waitForReady: async () => ({ ready: true, version: "1.0.0" }),
        readVersion: async () => "1.0.0",
        versionTimeoutMs: 1000,
    };
    return { context, calls, commands, runner, io };
}

async function instanceExists(record: ServiceRecord): Promise<boolean[]> {
    return Promise.all([record.configDir, record.stateDir, record.dataDir, record.runtimeDir].map(exists));
}

describe("bob uninstall", () => {
    it("removes the service, the link and the program folder and keeps and prints the instance directories by default", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        await hold(layout);
        const { context, calls, runner, io } = setup();

        const status = await runUninstall({ context, yes: false, removeData: false, runner });

        assert.equal(status, 0);
        assert.deepEqual(calls, ["stop", "remove"]);
        assert.equal(await exists(layout.bobLink), false);
        assert.equal(await exists(layout.root), false);
        assert.deepEqual(await instanceExists(record), [true, true, true, true]);
        for (const dir of [record.configDir, record.stateDir, record.dataDir, record.runtimeDir]) {
            assert.ok(io.out().includes(dir), `${dir} is printed`);
        }
    });

    it("removes the four instance directories and leaves the pi agent folder with --yes --remove-data and no terminal", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, runner } = setup();

        const status = await runUninstall({ context, yes: true, removeData: true, runner });

        assert.equal(status, 0);
        assert.deepEqual(await instanceExists(record), [false, false, false, false]);
        assert.equal(await exists(join(record.stateDir, "upgrades")), false);
        assert.equal(await exists(join(record.piAgentDir, "file")), true);
    });

    it("keeps the data without --remove-data when there is no terminal", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, runner } = setup();

        const status = await runUninstall({ context, yes: false, removeData: false, runner });

        assert.equal(status, 0);
        assert.deepEqual(await instanceExists(record), [true, true, true, true]);
    });

    it("keeps the data with --yes and no --remove-data on a terminal, without asking", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, runner } = setup({ isTerminal: true });
        const ask = async () => assert.fail("must not ask");

        const status = await runUninstall({ context, yes: true, removeData: false, runner, ask });

        assert.equal(status, 0);
        assert.deepEqual(await instanceExists(record), [true, true, true, true]);
    });

    it("removes the data without asking with --remove-data on a terminal", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, runner } = setup({ isTerminal: true });
        const ask = async () => assert.fail("must not ask");

        const status = await runUninstall({ context, yes: false, removeData: true, runner, ask });

        assert.equal(status, 0);
        assert.deepEqual(await instanceExists(record), [false, false, false, false]);
    });

    it("asks on a terminal with keep as the default and removes the data on a no to keeping", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, runner } = setup({ isTerminal: true });
        const questions: [string, boolean][] = [];
        const ask = async (question: string, defaultYes: boolean) => {
            questions.push([question, defaultYes]);
            return false;
        };

        const status = await runUninstall({ context, yes: false, removeData: false, runner, ask });

        assert.equal(status, 0);
        assert.deepEqual(questions, [["Keep the instance's data?", true]]);
        assert.deepEqual(await instanceExists(record), [false, false, false, false]);
    });

    it("keeps the data when the answer on a terminal is to keep it", async () => {
        const record = recordOf();
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, runner } = setup({ isTerminal: true });

        const status = await runUninstall({ context, yes: false, removeData: false, runner, ask: async () => true });

        assert.equal(status, 0);
        assert.deepEqual(await instanceExists(record), [true, true, true, true]);
    });

    it("turns lingering off when the record says bob service install turned it on", async () => {
        const record = recordOf({ lingerTurnedOn: true });
        await makeInstance(record);
        await writeServiceRecord(layout, record);
        const { context, commands, runner } = setup();

        const status = await runUninstall({ context, yes: true, removeData: false, runner });

        assert.equal(status, 0);
        assert.deepEqual(commands, [["loginctl", "disable-linger"]]);
    });

    it("asks sudo to turn lingering off when the account may not", async () => {
        const record = recordOf({ lingerTurnedOn: true });
        await writeServiceRecord(layout, record);
        const { context, commands } = setup();
        const runner: CommandRunner = async (command, args) => {
            commands.push([command, ...args]);
            return { code: command === "loginctl" && args.length === 1 ? 1 : 0, stdout: "", stderr: "" };
        };

        const status = await runUninstall({ context, yes: true, removeData: false, runner, user: "bob" });

        assert.equal(status, 0);
        assert.deepEqual(commands.at(-1), ["sudo", "-n", "loginctl", "disable-linger", "bob"]);
    });

    it("exits 1 and keeps the record when lingering can't be turned off", async () => {
        const record = recordOf({ lingerTurnedOn: true });
        await writeServiceRecord(layout, record);
        const { context, io } = setup();
        const runner: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "" });

        const status = await runUninstall({ context, yes: true, removeData: false, runner });

        assert.equal(status, 1);
        assert.match(io.err(), /lingering/);
        assert.equal(await exists(layout.serviceRecord), true);
    });

    it("finishes on a rerun after lingering was refused, though the service is already removed", async () => {
        const record = recordOf({ lingerTurnedOn: true });
        await writeServiceRecord(layout, record);
        const { context, calls } = setup();
        let isRegistered = true;
        const manager: ServiceManager = {
            ...fakeManager(calls),
            stop: async () => {
                if (!isRegistered) throw new Error("systemctl --user stop was refused: unit not loaded");
                calls.push("stop");
            },
            remove: async () => {
                isRegistered = false;
                calls.push("remove");
            },
            state: async () => ({ registered: isRegistered, startsAtBoot: isRegistered }),
        };
        const withManager = { ...context, managerFor: () => manager };
        const refusing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "" });
        const working: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });

        const first = await runUninstall({ context: withManager, yes: true, removeData: false, runner: refusing });
        const second = await runUninstall({ context: withManager, yes: true, removeData: false, runner: working });

        assert.equal(first, 1);
        assert.equal(second, 0);
        assert.equal(await exists(layout.root), false);
    });

    it("doesn't turn lingering off when the record says it was on before", async () => {
        const record = recordOf({ lingerTurnedOn: false });
        await writeServiceRecord(layout, record);
        const { context, commands, runner } = setup();

        const status = await runUninstall({ context, yes: true, removeData: false, runner });

        assert.equal(status, 0);
        assert.deepEqual(commands, []);
    });

    it("leaves a link that isn't the program's", async () => {
        await rm(layout.bobLink);
        await symlink("/usr/bin/env", layout.bobLink);
        const { context, runner } = setup();

        const status = await runUninstall({ context, yes: true, removeData: false, runner });

        assert.equal(status, 0);
        assert.equal(await readlink(layout.bobLink), "/usr/bin/env");
        assert.equal(await exists(layout.root), false);
    });

    it("removes the environment's instance directories when there is no record", async () => {
        const stateDir = join(home, "xdg-state", "the-intern");
        await mkdir(join(stateDir, "upgrades"), { recursive: true });
        const { context, calls, runner } = setup();

        const status = await runUninstall({ context, yes: true, removeData: true, runner });

        assert.equal(status, 0);
        assert.deepEqual(calls, []);
        assert.equal(await exists(stateDir), false);
        assert.equal(await exists(layout.root), false);
    });

    it("exits 1 and leaves the program folder when the service can't be stopped", async () => {
        await writeServiceRecord(layout, recordOf());
        const { context, io, runner } = setup();
        const failing: ServiceManager = {
            ...fakeManager([]),
            stop: async () => {
                throw new Error("systemctl --user stop was refused");
            },
        };

        const status = await runUninstall({
            context: { ...context, managerFor: () => failing },
            yes: true,
            removeData: false,
            runner,
        });

        assert.equal(status, 1);
        assert.match(io.err(), /refused/);
        assert.equal((await stat(layout.root)).isDirectory(), true);
    });
});
