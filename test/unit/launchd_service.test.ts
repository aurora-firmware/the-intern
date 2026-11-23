import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { launchdService, renderPlist } from "../../src/install/launchd_service.ts";
import { programLayout } from "../../src/install/program_layout.ts";
import {
    type CommandResult,
    type CommandRunner,
    type ServiceRecord,
    ServiceRefusedError,
} from "../../src/install/service_manager.ts";

const USER = "ada";
const LABEL = "com.aurora-firmware.the-intern";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
const OWNERSHIP_MODULE = new URL("../../src/daemon/ownership.ts", import.meta.url).href;

// A child that takes the owner lock and releases it, then exits, when it gets SIGTERM.
const LOCK_HOLDING_CHILD = `
import { acquireOwnership } from ${JSON.stringify(OWNERSHIP_MODULE)};
const handle = await acquireOwnership(process.argv[1]);
process.on("SIGTERM", async () => {
    await handle.release();
    process.exit(0);
});
console.log("ready");
setInterval(() => {}, 1000);
`;

let scratch: string;
let counter = 0;
const children: ChildProcess[] = [];

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "launchd-service-"));
});

afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

function newRecord(stateDir = "/h/state"): ServiceRecord {
    return {
        format: 1,
        platform: "darwin-arm64",
        label: LABEL,
        configDir: "/h/config",
        stateDir,
        dataDir: "/h/data",
        runtimeDir: "/h/runtime",
        piAgentDir: "/h/pi",
        path: "/usr/bin:/bin",
        lingerTurnedOn: false,
    };
}

type Call = { command: string; args: string[]; stdin?: "inherit" | "ignore" };

function fakeRunner(answer: (line: string) => Partial<CommandResult> | undefined = () => undefined) {
    const calls: Call[] = [];
    const runner: CommandRunner = async (command, args, options) => {
        calls.push({ command, args, stdin: options?.stdin });
        return { ...OK, ...answer(`${command} ${args.join(" ")}`) };
    };
    const lines = () => calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    const sudoCalls = () => calls.filter((call) => call.command === "sudo");
    return { runner, calls, lines, sudoCalls };
}

async function setup(answer?: (line: string) => Partial<CommandResult> | undefined, isTerminal = false) {
    counter += 1;
    const home = join(scratch, `home-${counter}`);
    const stateDir = join(home, "state");
    const plistPath = join(home, "LaunchDaemons", `${LABEL}.plist`);
    await mkdir(stateDir, { recursive: true });
    const layout = programLayout(home);
    const fake = fakeRunner(answer);
    const manager = launchdService(fake.runner, layout, { userName: USER, plistPath, isTerminal: () => isTerminal });
    return { home, layout, fake, manager, plistPath, stateDir, record: newRecord(stateDir) };
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function writePlist(plistPath: string, userName: string): Promise<void> {
    await mkdir(join(plistPath, ".."), { recursive: true });
    await writeFile(plistPath, renderPlist(newRecord(), programLayout("/home/ada"), userName));
}

const NO_IO = { writeLine: () => {} };

describe("renderPlist", () => {
    const layout = programLayout("/home/ada");
    const plist = renderPlist(newRecord(), layout, USER);

    it("keeps the service alive only while the hold file is absent", () => {
        const keepAlive = /<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>\s*(?:<key>|<\/dict>\s*<\/plist>)/.exec(
            plist,
        );
        assert.ok(keepAlive, "no KeepAlive dict");
        const body = keepAlive[1] ?? "";
        assert.equal((body.match(/<key>/g) ?? []).length, 2);
        assert.match(body, /<key>PathState<\/key>/);
        assert.match(body, new RegExp(`<key>${layout.holdFile.replaceAll("/", "\\/")}<\\/key>\\s*<false\\/>`));
    });

    it("names the label, the account, the start at load and the log file", () => {
        assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
        assert.match(plist, /<key>UserName<\/key>\s*<string>ada<\/string>/);
        assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
        assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/h\/state\/service\.log<\/string>/);
    });

    it("runs the stable program path with the four directory flags", () => {
        const args = [
            "/home/ada/.local/lib/the-intern/current/bin/bob",
            "serve",
            "--config-dir",
            "/h/config",
            "--state-dir",
            "/h/state",
            "--data-dir",
            "/h/data",
            "--runtime-dir",
            "/h/runtime",
        ];
        const expected = args.map((arg) => `<string>${arg}</string>`).join("\\s*");
        assert.match(plist, new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*${expected}\\s*</array>`));
    });

    it("sets the environment", () => {
        for (const [name, value] of [
            ["PI_CODING_AGENT_DIR", "/h/pi"],
            ["PATH", "/usr/bin:/bin"],
            ["HOME", "/home/ada"],
            ["BOB_SERVICE_LABEL", LABEL],
        ]) {
            assert.match(plist, new RegExp(`<key>${name}</key>\\s*<string>${value}</string>`));
        }
    });

    it("escapes characters that are special in XML", () => {
        const record = { ...newRecord(), path: "/a&b:/c<d" };
        assert.match(renderPlist(record, layout, USER), /<string>\/a&amp;b:\/c&lt;d<\/string>/);
    });
});

describe("register", () => {
    it("makes exactly one sudo call that installs the plist and bootstraps it", async () => {
        const { fake, manager, record } = await setup();
        await manager.register(record, NO_IO);
        const sudo = fake.sudoCalls();
        assert.equal(sudo.length, 1);
        assert.equal(fake.calls.length, 1);
        const args = sudo[0]?.args ?? [];
        assert.deepEqual(args.slice(0, 3), ["-n", "/bin/sh", "-c"]);
        assert.match(args[3] ?? "", /0644/);
        assert.match(args[3] ?? "", /launchctl bootstrap system/);
    });

    it("installs the rendered plist from a temporary file to the daemons folder", async () => {
        let installed = "";
        const { layout, fake, record, plistPath } = await setup();
        const capturing = launchdService(
            async (command, args, options) => {
                const source = args[5] ?? "";
                installed = await readFile(source, "utf8");
                return fake.runner(command, args, options);
            },
            layout,
            { userName: USER, plistPath, isTerminal: () => false },
        );
        await capturing.register(record, NO_IO);
        assert.equal(installed, renderPlist(record, layout, USER));
        assert.equal(fake.sudoCalls()[0]?.args[6], plistPath);
    });

    it("creates service.log owner-only", async () => {
        const { manager, record, stateDir } = await setup();
        await manager.register(record, NO_IO);
        assert.equal((await stat(join(stateDir, "service.log"))).mode & 0o777, 0o600);
    });

    it("asks sudo on a terminal", async () => {
        const { fake, manager, record } = await setup(undefined, true);
        await manager.register(record, NO_IO);
        const sudo = fake.sudoCalls()[0];
        assert.deepEqual(sudo?.args.slice(0, 2), ["/bin/sh", "-c"]);
        assert.equal(sudo?.stdin, "inherit");
    });

    it("throws naming admin rights and leaves no service.log when sudo is refused", async () => {
        const { manager, record, stateDir } = await setup(() => ({ code: 1, stderr: "sudo: a password is required" }));
        await assert.rejects(
            manager.register(record, NO_IO),
            (error: unknown) =>
                error instanceof ServiceRefusedError &&
                /admin rights/.test(error.reason) &&
                /nothing was registered/.test(error.reason),
        );
        assert.equal(await exists(join(stateDir, "service.log")), false);
    });

    it("keeps an existing service.log when sudo is refused", async () => {
        const { manager, record, stateDir } = await setup(() => ({ code: 1 }));
        await writeFile(join(stateDir, "service.log"), "old\n");
        await assert.rejects(manager.register(record, NO_IO), ServiceRefusedError);
        assert.equal(await readFile(join(stateDir, "service.log"), "utf8"), "old\n");
    });

    it("refuses without running anything when a plist for another account exists", async () => {
        const { fake, manager, record, plistPath, stateDir } = await setup();
        await writePlist(plistPath, "grace");
        await assert.rejects(
            manager.register(record, NO_IO),
            (error: unknown) => error instanceof ServiceRefusedError && /grace/.test(error.reason),
        );
        assert.deepEqual(fake.calls, []);
        assert.equal(await exists(join(stateDir, "service.log")), false);
    });

    it("registers again over a plist for the same account", async () => {
        const { fake, manager, record, plistPath } = await setup();
        await writePlist(plistPath, USER);
        await manager.register(record, NO_IO);
        assert.equal(fake.sudoCalls().length, 1);
        assert.match(fake.sudoCalls()[0]?.args[3] ?? "", /^launchctl bootout system\/.*; \/usr\/bin\/install/);
    });
});

describe("the replace script when the install step fails", () => {
    it("puts the previous plist back and boots it in again", async () => {
        const { record, plistPath, home } = await setup();
        await writePlist(plistPath, USER);
        const before = await readFile(plistPath, "utf8");
        const bin = join(home, "bin");
        const log = join(home, "launchctl.log");
        await mkdir(bin);
        await writeFile(join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 });
        await writeFile(join(bin, "install"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const fake = fakeRunner();
        const layout = programLayout(home);
        const registering = launchdService(fake.runner, layout, {
            userName: USER,
            plistPath,
            isTerminal: () => false,
        });
        await registering.register(record, NO_IO);
        const script = (fake.sudoCalls()[0]?.args[3] ?? "").replaceAll("/usr/bin/install", join(bin, "install"));
        const run = spawnSync("/bin/sh", ["-c", script, "sh", join(home, "new.plist"), plistPath], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        assert.notEqual(run.status, 0);
        assert.equal(await readFile(plistPath, "utf8"), before);
        assert.equal(await exists(`${plistPath}.prev`), false);
        const calls = (await readFile(log, "utf8")).trim().split("\n");
        assert.deepEqual(calls, [`bootout system/${LABEL}`, `bootstrap system ${plistPath}`]);
    });
});

describe("remove", () => {
    it("boots the job out and removes the file in one sudo call", async () => {
        const { fake, manager, record, plistPath } = await setup();
        await manager.remove(record, NO_IO);
        assert.equal(fake.calls.length, 1);
        const args = fake.sudoCalls()[0]?.args ?? [];
        assert.deepEqual(args.slice(0, 3), ["-n", "/bin/sh", "-c"]);
        assert.match(args[3] ?? "", new RegExp(`launchctl bootout system/${LABEL}`));
        assert.match(args[3] ?? "", /rm -f/);
        assert.equal(args[6], plistPath);
    });

    it("throws naming admin rights when sudo is refused", async () => {
        const { manager, record } = await setup(() => ({ code: 1 }));
        await assert.rejects(
            manager.remove(record, NO_IO),
            (error: unknown) =>
                error instanceof ServiceRefusedError &&
                /admin rights/.test(error.reason) &&
                /still registered/.test(error.reason),
        );
    });
});

describe("stop and start", () => {
    it("creates the hold file and returns at once without sudo when no daemon holds the lock", async () => {
        const { fake, layout, manager, record } = await setup();
        await manager.stop(record);
        assert.equal(await exists(layout.holdFile), true);
        assert.deepEqual(fake.calls, []);
    });

    it("sends SIGTERM to the lock's pid and returns once the lock is released", async () => {
        const { layout, manager, record, stateDir } = await setup();
        const child = spawn(process.execPath, ["--input-type=module", "-e", LOCK_HOLDING_CHILD, stateDir], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        children.push(child);
        await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
        const exited = new Promise((resolve) => child.once("exit", resolve));

        await manager.stop(record);

        assert.equal(await exists(layout.holdFile), true);
        assert.equal(await exists(join(stateDir, "owner.lock")), false);
        assert.equal(child.signalCode ?? child.exitCode, 0);
        await exited;
    });

    it("removes the hold file without sudo on start", async () => {
        const { fake, layout, manager, record } = await setup();
        await manager.stop(record);
        await manager.start(record);
        assert.equal(await exists(layout.holdFile), false);
        assert.deepEqual(fake.calls, []);
    });
});

describe("state and logCommand", () => {
    it("is not registered without a plist", async () => {
        const { fake, manager, record } = await setup();
        assert.deepEqual(await manager.state(record), { registered: false, startsAtBoot: false });
        assert.deepEqual(fake.calls, []);
    });

    it("starts at boot when registered and the label is not disabled", async () => {
        const { manager, record, plistPath } = await setup((line) =>
            line === "launchctl print-disabled system"
                ? { stdout: `disabled services = {\n\t"com.other" => disabled\n\t"${LABEL}" => enabled\n}\n` }
                : undefined,
        );
        await writePlist(plistPath, USER);
        assert.deepEqual(await manager.state(record), { registered: true, startsAtBoot: true });
    });

    it("does not start at boot when the label is disabled", async () => {
        const { manager, record, plistPath } = await setup((line) =>
            line === "launchctl print-disabled system"
                ? { stdout: `disabled services = {\n\t"${LABEL}" => disabled\n}\n` }
                : undefined,
        );
        await writePlist(plistPath, USER);
        assert.deepEqual(await manager.state(record), { registered: true, startsAtBoot: false });
    });

    it("names the tail command on service.log", async () => {
        const { manager } = await setup();
        assert.equal(manager.logCommand(newRecord()), "tail -n 100 /h/state/service.log");
    });
});
