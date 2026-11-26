import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { programLayout } from "../../src/install/program_layout.ts";
import {
    type CommandResult,
    type CommandRunner,
    type ServiceRecord,
    ServiceRefusedError,
} from "../../src/install/service_manager.ts";
import { renderUnit, systemdService } from "../../src/install/systemd_service.ts";

const USER = "ada";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

let scratch: string;
let counter = 0;

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "systemd-service-"));
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

function newRecord(): ServiceRecord {
    return {
        format: 1,
        platform: "linux-x64",
        label: "the-intern.service",
        configDir: "/h/config",
        stateDir: "/h/state",
        dataDir: "/h/data",
        runtimeDir: "/h/runtime",
        piAgentDir: "/h/pi",
        path: "/usr/bin:/bin",
        lingerTurnedOn: false,
    };
}

type Call = { command: string; args: string[]; stdin?: "inherit" | "ignore" };

/** A runner that records every call and answers from `answer`, success when it returns nothing. */
function fakeRunner(answer: (line: string) => Partial<CommandResult> | undefined = () => undefined) {
    const calls: Call[] = [];
    const runner: CommandRunner = async (command, args, options) => {
        calls.push({ command, args, stdin: options?.stdin });
        return { ...OK, ...answer(`${command} ${args.join(" ")}`) };
    };
    const lines = () => calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    return { runner, calls, lines };
}

async function setup(answer?: (line: string) => Partial<CommandResult> | undefined, isTerminal = false) {
    counter += 1;
    const home = join(scratch, `home-${counter}`);
    await mkdir(home);
    const layout = programLayout(home);
    const fake = fakeRunner(answer);
    const manager = systemdService(fake.runner, layout, { user: USER, isTerminal: () => isTerminal });
    const unitFile = join(home, ".config", "systemd", "user", "the-intern.service");
    return { home, layout, fake, manager, unitFile };
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

const LINGER_REFUSED = (line: string) =>
    line.includes("enable-linger") ? { code: 1, stderr: "Access denied" } : undefined;

describe("renderUnit", () => {
    it("names the stable program path, the directory flags and the environment", () => {
        const layout = programLayout("/home/ada");
        const unit = renderUnit(newRecord(), layout);
        assert.match(
            unit,
            /^ExecStart=\/home\/ada\/\.local\/lib\/the-intern\/current\/bin\/bob serve --config-dir \/h\/config --state-dir \/h\/state --data-dir \/h\/data --runtime-dir \/h\/runtime$/m,
        );
        assert.match(unit, /^Environment="PI_CODING_AGENT_DIR=\/h\/pi"$/m);
        assert.match(unit, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
        assert.match(unit, /^Environment="HOME=\/home\/ada"$/m);
        assert.match(unit, /^Environment="BOB_SERVICE_LABEL=the-intern\.service"$/m);
    });

    it("sets the restart, stop, hold file and boot lines", () => {
        const layout = programLayout("/home/ada");
        const unit = renderUnit(newRecord(), layout);
        for (const line of [
            "Restart=on-failure",
            "RestartSec=5",
            "KillMode=mixed",
            "TimeoutStopSec=20",
            `ConditionPathExists=!${layout.holdFile}`,
            "WantedBy=default.target",
        ]) {
            assert.ok(unit.split("\n").includes(line), `missing ${line}`);
        }
    });

    it("puts the start limit in the Unit section, where systemd reads it", () => {
        const unit = renderUnit(newRecord(), programLayout("/home/ada"));
        const sectionOf = (section: string) => {
            const body = unit.split(`[${section}]\n`)[1] ?? "";
            return body.split(/^\[/m)[0].split("\n");
        };
        assert.ok(sectionOf("Unit").includes("StartLimitIntervalSec=0"));
        assert.ok(!sectionOf("Service").includes("StartLimitIntervalSec=0"));
    });
});

describe("register", () => {
    it("turns lingering on, writes the unit, then reloads, enables and starts", async () => {
        const { fake, manager, unitFile } = await setup();
        const record = newRecord();
        await manager.register(record, { writeLine: () => {} });
        assert.deepEqual(fake.lines(), [
            "systemctl --user show-environment",
            `loginctl show-user ${USER} -p Linger`,
            "loginctl enable-linger",
            "systemctl --user daemon-reload",
            "systemctl --user enable the-intern.service",
            "systemctl --user start the-intern.service",
        ]);
        assert.equal(await exists(unitFile), true);
        assert.equal(record.lingerTurnedOn, true);
    });

    it("leaves lingering alone and says so when it was already on", async () => {
        const { fake, manager } = await setup((line) =>
            line.includes("show-user") ? { stdout: "Linger=yes\n" } : undefined,
        );
        const record = newRecord();
        await manager.register(record, { writeLine: () => {} });
        assert.equal(
            fake.lines().some((line) => line.includes("enable-linger")),
            false,
        );
        assert.equal(record.lingerTurnedOn, false);
    });

    it("asks sudo on a terminal when the account is refused", async () => {
        const { fake, manager } = await setup(
            (line) => (line === "loginctl enable-linger" ? { code: 1 } : undefined),
            true,
        );
        const record = newRecord();
        await manager.register(record, { writeLine: () => {} });
        const sudo = fake.calls.find((call) => call.command === "sudo");
        assert.deepEqual(sudo?.args, ["loginctl", "enable-linger", USER]);
        assert.equal(sudo?.stdin, "inherit");
        assert.equal(record.lingerTurnedOn, true);
    });

    it("uses sudo -n without a terminal", async () => {
        const { fake, manager } = await setup((line) => (line === "loginctl enable-linger" ? { code: 1 } : undefined));
        await manager.register(newRecord(), { writeLine: () => {} });
        const sudo = fake.calls.find((call) => call.command === "sudo");
        assert.deepEqual(sudo?.args, ["-n", "loginctl", "enable-linger", USER]);
        assert.equal(sudo?.stdin, "ignore");
    });

    it("throws naming admin rights and leaves no unit when lingering is refused both ways", async () => {
        const { fake, manager, unitFile } = await setup(LINGER_REFUSED);
        const record = newRecord();
        await assert.rejects(
            manager.register(record, { writeLine: () => {} }),
            (error: unknown) => error instanceof ServiceRefusedError && /admin rights/.test(error.reason),
        );
        assert.equal(await exists(unitFile), false);
        assert.equal(record.lingerTurnedOn, false);
        assert.equal(
            fake.lines().some((line) => line.includes("daemon-reload")),
            false,
        );
    });

    it("throws naming the reason and registers nothing when the user manager is unreachable", async () => {
        const { fake, manager, unitFile } = await setup((line) =>
            line === "systemctl --user show-environment" ? { code: 1, stderr: "Failed to connect to bus" } : undefined,
        );
        await assert.rejects(
            manager.register(newRecord(), { writeLine: () => {} }),
            (error: unknown) =>
                error instanceof ServiceRefusedError &&
                /user manager/.test(error.reason) &&
                /Failed to connect to bus/.test(error.reason),
        );
        assert.equal(await exists(unitFile), false);
        assert.deepEqual(fake.lines(), ["systemctl --user show-environment"]);
    });

    it("undoes the unit and lingering when enable is refused", async () => {
        const { fake, manager, unitFile } = await setup((line) =>
            line.includes(" enable the-intern") ? { code: 1, stderr: "denied" } : undefined,
        );
        const record = newRecord();
        await assert.rejects(manager.register(record, { writeLine: () => {} }), ServiceRefusedError);
        assert.equal(await exists(unitFile), false);
        assert.equal(record.lingerTurnedOn, false);
        const lines = fake.lines();
        assert.ok(lines.includes("loginctl disable-linger"));
        assert.ok(
            lines.lastIndexOf("systemctl --user daemon-reload") >
                lines.indexOf("systemctl --user enable the-intern.service"),
        );
    });

    it("disables the unit and removes it when start is refused", async () => {
        const { fake, manager, unitFile } = await setup((line) =>
            line.includes(" start the-intern") ? { code: 1, stderr: "failed" } : undefined,
        );
        await assert.rejects(manager.register(newRecord(), { writeLine: () => {} }), ServiceRefusedError);
        assert.equal(await exists(unitFile), false);
        assert.ok(fake.lines().includes("systemctl --user disable the-intern.service"));
    });

    it("writes a unit that matches renderUnit", async () => {
        const { layout, manager, unitFile } = await setup();
        const record = newRecord();
        await manager.register(record, { writeLine: () => {} });
        assert.equal(await readFile(unitFile, "utf8"), renderUnit(record, layout));
    });
});

describe("remove, stop, start, state and logCommand", () => {
    it("stops, disables, removes the unit and reloads", async () => {
        const { fake, manager, unitFile } = await setup();
        await manager.register(newRecord(), { writeLine: () => {} });
        fake.calls.length = 0;
        await manager.remove(newRecord(), { writeLine: () => {} });
        assert.deepEqual(fake.lines(), [
            "systemctl --user stop the-intern.service",
            "systemctl --user disable the-intern.service",
            "systemctl --user daemon-reload",
        ]);
        assert.equal(await exists(unitFile), false);
    });

    it("stops and starts through systemctl --user without sudo", async () => {
        const { fake, manager } = await setup();
        await manager.stop(newRecord());
        await manager.start(newRecord());
        assert.deepEqual(fake.lines(), [
            "systemctl --user stop the-intern.service",
            "systemctl --user start the-intern.service",
        ]);
        assert.equal(
            fake.calls.some((call) => call.command === "sudo"),
            false,
        );
    });

    it("throws when stop is refused", async () => {
        const { manager } = await setup(() => ({ code: 1, stderr: "nope" }));
        await assert.rejects(manager.stop(newRecord()), ServiceRefusedError);
    });

    it("reports registered and starting at boot when enabled with lingering", async () => {
        const { manager } = await setup((line) => {
            if (line.includes("is-enabled")) return { stdout: "enabled\n" };
            if (line.includes("show-user")) return { stdout: "Linger=yes\n" };
            return undefined;
        });
        await manager.register(newRecord(), { writeLine: () => {} });
        assert.deepEqual(await manager.state(newRecord()), { registered: true, startsAtBoot: true });
    });

    it("reports registered but not starting at boot without lingering", async () => {
        const { manager } = await setup((line) => {
            if (line.includes("is-enabled")) return { stdout: "enabled\n" };
            if (line.includes("show-user")) return { stdout: "Linger=no\n" };
            return undefined;
        });
        await manager.register(newRecord(), { writeLine: () => {} });
        assert.deepEqual(await manager.state(newRecord()), { registered: true, startsAtBoot: false });
    });

    it("reports a disabled unit as registered but not starting at boot", async () => {
        const { manager } = await setup((line) => {
            if (line.includes("is-enabled")) return { code: 1, stdout: "disabled\n" };
            if (line.includes("show-user")) return { stdout: "Linger=yes\n" };
            return undefined;
        });
        await manager.register(newRecord(), { writeLine: () => {} });
        assert.deepEqual(await manager.state(newRecord()), { registered: true, startsAtBoot: false });
    });

    it("reports not registered without a unit file", async () => {
        const { fake, manager } = await setup((line) =>
            line.includes("is-enabled") ? { stdout: "enabled\n" } : undefined,
        );
        assert.deepEqual(await manager.state(newRecord()), { registered: false, startsAtBoot: false });
        assert.deepEqual(fake.lines(), []);
    });

    it("names the journalctl command", async () => {
        const { manager } = await setup();
        assert.equal(manager.logCommand(newRecord()), "journalctl --user -u the-intern.service");
    });
});
