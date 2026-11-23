import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { acquireInstallLock } from "../../src/daemon/ownership.ts";
import type { PlatformFacts } from "../../src/install/install_model.ts";
import { type OperationJournal, type Resumers, writeJournal } from "../../src/install/operation_journal.ts";
import { type ProgramLayout, programLayout, readLink, switchLink } from "../../src/install/program_layout.ts";
import type { ReadyWaitResult } from "../../src/install/ready_wait.ts";
import {
    runServiceInstall,
    runServiceRemove,
    runServiceStatus,
    type ServiceCommandContext,
    serviceManagerFor,
    withInstallLock,
} from "../../src/install/service_commands.ts";
import {
    hold,
    readServiceRecord,
    type ServiceManager,
    type ServiceRecord,
    ServiceRefusedError,
    type ServiceState,
    writeServiceRecord,
} from "../../src/install/service_manager.ts";
import { scaled } from "../support/time_scale.ts";

const LINUX: PlatformFacts = { platform: "linux", arch: "x64", hasGlibc: true, hasSystemd: true, uid: 1000 };
const LOG_COMMAND = "journalctl --user -u the-intern.service";

let home: string;
let layout: ProgramLayout;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "service-commands-"));
    layout = programLayout(home);
    await mkdir(layout.root, { recursive: true });
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

function capture() {
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
        isStdinTerminal: false,
    } satisfies CommandIo;
    return { io, out: () => out, err: () => err };
}

type FakeManager = ServiceManager & { calls: string[]; setState(state: ServiceState): void; failRegister?: string };

function fakeManager(): FakeManager {
    let state: ServiceState = { registered: false, startsAtBoot: false };
    const manager: FakeManager = {
        calls: [],
        setState(next) {
            state = next;
        },
        async register(record) {
            manager.calls.push("register");
            if (manager.failRegister !== undefined) throw new ServiceRefusedError(manager.failRegister);
            record.lingerTurnedOn = true;
            state = { registered: true, startsAtBoot: true };
        },
        async remove() {
            manager.calls.push("remove");
            state = { registered: false, startsAtBoot: false };
        },
        async stop() {
            manager.calls.push("stop");
        },
        async start() {
            manager.calls.push("start");
        },
        async state() {
            return state;
        },
        logCommand: () => LOG_COMMAND,
    };
    return manager;
}

const NO_RESUMERS: Resumers = {
    upgrade: async () => {},
    "switch-back": async () => {},
    "fresh-start": async () => {},
    rollback: async () => {},
};

function setup(overrides: Partial<ServiceCommandContext> = {}) {
    const io = capture();
    const manager = fakeManager();
    const context: ServiceCommandContext = {
        io: io.io,
        layout,
        facts: LINUX,
        managerFor: () => manager,
        resumers: NO_RESUMERS,
        waitForReady: async (): Promise<ReadyWaitResult> => ({ ready: true, version: "1.2.0" }),
        readVersion: async () => "1.2.0",
        versionTimeoutMs: scaled(1000),
        ...overrides,
    };
    return { context, manager, io };
}

function recordOf(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
    return {
        format: 1,
        platform: "linux-x64",
        label: "the-intern.service",
        configDir: "/r/config",
        stateDir: "/r/state",
        dataDir: "/r/data",
        runtimeDir: "/r/run",
        piAgentDir: "/r/pi",
        path: "/usr/bin",
        lingerTurnedOn: true,
        ...overrides,
    };
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

describe("bob service status", () => {
    it("prints the contract's object with nulls and exit 0 when nothing is registered", async () => {
        const { context, io } = setup();

        const status = await runServiceStatus(context, { json: true });

        assert.equal(status, 0);
        assert.deepEqual(JSON.parse(io.out()), {
            registered: false,
            startsAtBoot: false,
            running: false,
            version: null,
            configDir: null,
            stateDir: null,
            dataDir: null,
            runtimeDir: null,
            piAgentDir: null,
        });
    });

    it("prints the running daemon's version and the record's directories when registered", async () => {
        const { context, manager, io } = setup();
        await writeServiceRecord(layout, recordOf());
        manager.setState({ registered: true, startsAtBoot: true });

        const status = await runServiceStatus(context, { json: true });

        assert.equal(status, 0);
        assert.deepEqual(JSON.parse(io.out()), {
            registered: true,
            startsAtBoot: true,
            running: true,
            version: "1.2.0",
            configDir: "/r/config",
            stateDir: "/r/state",
            dataDir: "/r/data",
            runtimeDir: "/r/run",
            piAgentDir: "/r/pi",
        });
    });

    it("reports a registered service whose daemon doesn't answer as not running", async () => {
        const { context, manager, io } = setup({ readVersion: async () => null });
        await writeServiceRecord(layout, recordOf());
        manager.setState({ registered: true, startsAtBoot: true });

        const status = await runServiceStatus(context, { json: true });

        assert.equal(status, 0);
        const printed = JSON.parse(io.out());
        assert.equal(printed.running, false);
        assert.equal(printed.version, null);
    });

    it("ends with exit 0 and not running when the daemon accepts the call and never answers", async () => {
        const { context, manager, io } = setup({
            readVersion: () => new Promise(() => {}),
            versionTimeoutMs: scaled(50),
        });
        await writeServiceRecord(layout, recordOf());
        manager.setState({ registered: true, startsAtBoot: true });

        const status = await runServiceStatus(context, { json: true });

        assert.equal(status, 0);
        assert.equal(JSON.parse(io.out()).running, false);
    });

    it("names the current and previous versions, a hold and a cut-off operation in the text form", async () => {
        const { context, manager, io } = setup();
        await writeServiceRecord(layout, recordOf());
        manager.setState({ registered: true, startsAtBoot: true });
        await switchLink(layout, "current", "1.2.0");
        await switchLink(layout, "previous", "1.1.0");
        await hold(layout);
        const journal: OperationJournal = {
            format: 1,
            operation: "upgrade",
            from: "1.1.0",
            to: "1.2.0",
            copyName: null,
            setAsideName: null,
            currentBefore: "1.1.0",
            previousBefore: null,
            lastStep: "copied",
        };
        await writeJournal(layout, journal);

        const status = await runServiceStatus(context, { json: false });

        assert.equal(status, 0);
        assert.match(io.out(), /Current version: 1\.2\.0/);
        assert.match(io.out(), /Previous version: 1\.1\.0/);
        assert.match(io.out(), /Held: yes/);
        assert.match(io.out(), /upgrade from 1\.1\.0 to 1\.2\.0 was cut off after copied/);
        assert.match(io.out(), /Running: yes \(version 1\.2\.0\)/);
    });

    it("takes no lock and changes nothing, even while another command holds the lock", async () => {
        const { context, io } = setup();
        const handle = await acquireInstallLock(layout.root, "upgrade");

        const status = await runServiceStatus(context, { json: true });
        await handle.release();

        assert.equal(status, 0);
        assert.equal(JSON.parse(io.out()).registered, false);
    });
});

describe("bob service install", () => {
    it("registers, writes the record from the environment and exits 0 once the daemon is ready", async () => {
        const { context, manager, io } = setup();

        const status = await runServiceInstall(context);

        assert.equal(status, 0);
        assert.deepEqual(manager.calls, ["register"]);
        const record = await readServiceRecord(layout);
        assert.equal(record?.stateDir, join(home, "xdg-state", "the-intern"));
        assert.equal(record?.piAgentDir, join(home, "pi"));
        assert.equal(record?.path, "/usr/bin:/bin");
        assert.equal(record?.platform, "linux-x64");
        assert.equal(record?.lingerTurnedOn, true, "the record keeps what register changed");
        assert.equal(io.out(), "");
    });

    it("exits 1 naming the startup report's reason and the log command when the daemon isn't ready", async () => {
        const report = {
            format: 1 as const,
            version: "1.2.0",
            pid: 1,
            serviceLabel: null,
            furthestStep: 2,
            failedStep: 3,
            failedStepName: "web",
            reason: "port 8080 is in use",
            unreadableDatabase: false,
            ready: false,
        };
        const { context, io } = setup({ waitForReady: async () => ({ ready: false, report }) });

        const status = await runServiceInstall(context);

        assert.equal(status, 1);
        assert.match(io.err(), /port 8080 is in use/);
        assert.ok(io.err().includes(LOG_COMMAND));
    });

    it("exits 1 naming that no startup report was written when the daemon never reported", async () => {
        const { context, io } = setup({ waitForReady: async () => ({ ready: false, report: undefined }) });

        const status = await runServiceInstall(context);

        assert.equal(status, 1);
        assert.match(io.err(), /no startup report/);
        assert.ok(io.err().includes(LOG_COMMAND));
    });

    it("exits 1 naming the reason and leaves no record when the registration is refused", async () => {
        const { context, manager, io } = setup();
        manager.failRegister = "admin rights were refused";

        const status = await runServiceInstall(context);

        assert.equal(status, 1);
        assert.match(io.err(), /admin rights were refused/);
        assert.equal(await readServiceRecord(layout), null);
    });

    it("keeps the earlier record when a repeated registration is refused", async () => {
        const { context, manager } = setup();
        await writeServiceRecord(layout, recordOf());
        manager.failRegister = "admin rights were refused";

        await runServiceInstall(context);

        assert.deepEqual(await readServiceRecord(layout), recordOf());
    });

    it("keeps the record's directories and pi agent folder when run again", async () => {
        const { context, manager } = setup();
        await writeServiceRecord(layout, recordOf({ lingerTurnedOn: true }));

        const status = await runServiceInstall(context);

        assert.equal(status, 0);
        assert.deepEqual(manager.calls, ["register"]);
        const record = await readServiceRecord(layout);
        assert.equal(record?.configDir, "/r/config");
        assert.equal(record?.stateDir, "/r/state");
        assert.equal(record?.dataDir, "/r/data");
        assert.equal(record?.runtimeDir, "/r/run");
        assert.equal(record?.piAgentDir, "/r/pi");
    });

    it("keeps that it turned lingering on when a repeated registration finds it already on", async () => {
        const manager = fakeManager();
        manager.register = async () => {};
        const { context } = setup({ managerFor: () => manager });
        await writeServiceRecord(layout, recordOf({ lingerTurnedOn: true }));

        await runServiceInstall(context);

        assert.equal((await readServiceRecord(layout))?.lingerTurnedOn, true);
    });

    it("refuses on a platform the product doesn't support, registering nothing", async () => {
        const { context, manager, io } = setup({ facts: { ...LINUX, uid: 0 } });

        const status = await runServiceInstall(context);

        assert.equal(status, 1);
        assert.match(io.err(), /not root/);
        assert.deepEqual(manager.calls, []);
    });

    it("refuses a program folder that lies inside an instance directory", async () => {
        const { context, manager, io } = setup();
        context.io.env.XDG_STATE_HOME = join(home, ".local", "lib");
        context.io.env.XDG_DATA_HOME = join(home, ".local", "lib", "the-intern");

        const status = await runServiceInstall(context);

        assert.equal(status, 1);
        assert.match(io.err(), /instance directory/);
        assert.deepEqual(manager.calls, []);
    });

    it("exits 1 naming the command that holds install.lock", async () => {
        const { context, manager, io } = setup();
        const handle = await acquireInstallLock(layout.root, "upgrade");

        const status = await runServiceInstall(context);
        await handle.release();

        assert.equal(status, 1);
        assert.match(io.err(), /upgrade/);
        assert.deepEqual(manager.calls, []);
    });

    it("finishes a cut-off operation with its resumer before it does its own work", async () => {
        const order: string[] = [];
        const manager = fakeManager();
        manager.register = async () => {
            order.push("register");
        };
        const { context } = setup({
            managerFor: () => manager,
            resumers: {
                ...NO_RESUMERS,
                upgrade: async () => {
                    order.push("resume upgrade");
                },
            },
        });
        await writeJournal(layout, {
            format: 1,
            operation: "upgrade",
            from: "1.1.0",
            to: "1.2.0",
            copyName: null,
            setAsideName: null,
            currentBefore: null,
            previousBefore: null,
            lastStep: "held",
        });

        await runServiceInstall(context);

        assert.deepEqual(order, ["resume upgrade", "register"]);
    });

    it("releases the lock when it ends", async () => {
        const { context } = setup();

        await runServiceInstall(context);

        assert.equal(await exists(layout.installLock), false);
    });
});

describe("bob service remove", () => {
    it("removes the registration, the record and the hold file, and leaves the program and data", async () => {
        const { context, manager } = setup();
        await writeServiceRecord(layout, recordOf());
        await hold(layout);
        await switchLink(layout, "current", "1.2.0");
        const dataDir = join(home, "data");
        await mkdir(dataDir);

        const status = await runServiceRemove(context);

        assert.equal(status, 0);
        assert.deepEqual(manager.calls, ["stop", "remove"]);
        assert.equal(await exists(layout.serviceRecord), false);
        assert.equal(await exists(layout.holdFile), false);
        assert.equal(await readLink(layout, "current"), "1.2.0");
        assert.equal(await exists(dataDir), true);
    });

    it("exits 0 and removes a leftover hold file when nothing is registered", async () => {
        const { context, manager } = setup();
        await hold(layout);

        const status = await runServiceRemove(context);

        assert.equal(status, 0);
        assert.deepEqual(manager.calls, []);
        assert.equal(await exists(layout.holdFile), false);
    });

    it("exits 1 naming the reason and keeps the record when the service can't be stopped", async () => {
        const manager = fakeManager();
        manager.stop = async () => {
            throw new ServiceRefusedError("systemctl --user stop was refused: busy");
        };
        const { context, io } = setup({ managerFor: () => manager });
        await writeServiceRecord(layout, recordOf());

        const status = await runServiceRemove(context);

        assert.equal(status, 1);
        assert.match(io.err(), /busy/);
        assert.deepEqual(await readServiceRecord(layout), recordOf());
    });

    it("exits 1 naming the command that holds install.lock", async () => {
        const { context, manager, io } = setup();
        await writeServiceRecord(layout, recordOf());
        const handle = await acquireInstallLock(layout.root, "rollback");

        const status = await runServiceRemove(context);
        await handle.release();

        assert.equal(status, 1);
        assert.match(io.err(), /rollback/);
        assert.deepEqual(manager.calls, []);
        assert.notEqual(await readServiceRecord(layout), null);
    });
});

describe("withInstallLock", () => {
    it("runs the work under the lock and releases it afterwards, even when the work throws", async () => {
        await assert.rejects(
            withInstallLock(layout, "service install", NO_RESUMERS, async () => {
                assert.equal(await exists(layout.installLock), true);
                throw new Error("boom");
            }),
            /boom/,
        );

        assert.equal(await exists(layout.installLock), false);
    });
});

describe("serviceManagerFor", () => {
    it("picks the manager whose log command belongs to the platform", () => {
        const runner = async () => ({ code: 0, stdout: "", stderr: "" });

        const systemd = serviceManagerFor("linux-x64", runner, layout);
        const launchd = serviceManagerFor("darwin-arm64", runner, layout);

        assert.equal(systemd.logCommand(recordOf()), LOG_COMMAND);
        assert.match(launchd.logCommand(recordOf({ platform: "darwin-arm64" })), /^tail -n 100 /);
    });
});
