/**
 * The Linux service manager (ADR-012 decisions 1, 2 and 4): a systemd user unit with lingering, so the service starts
 * at boot with nobody logged in. The supervisors' commands go through the injected command runner; the unit is
 * rendered by a pure function.
 */
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ProgramLayout } from "./program_layout.ts";
import {
    type CommandResult,
    type CommandRunner,
    type ServiceManager,
    type ServiceRecord,
    ServiceRefusedError,
    type ServiceState,
} from "./service_manager.ts";

const UNIT_NAME = "the-intern.service";
const LOG_COMMAND = `journalctl --user -u ${UNIT_NAME}`;
const PROGRAM_FOLDER_DEPTH = 3;

export type SystemdOptions = {
    /** The account whose lingering is turned on. Defaults to the current account. */
    user?: string;
    /** Whether `sudo` may ask for a password on a terminal. Defaults to whether standard input is one. */
    isTerminal?: () => boolean;
};

/** The home directory the program folder `<home>/.local/lib/the-intern` lies under. */
function homeOf(layout: ProgramLayout): string {
    let home = layout.root;
    for (let level = 0; level < PROGRAM_FOLDER_DEPTH; level += 1) home = dirname(home);
    return home;
}

function unitFilePath(layout: ProgramLayout): string {
    return join(homeOf(layout), ".config", "systemd", "user", UNIT_NAME);
}

function quoteEnvironment(name: string, value: string): string {
    return `Environment="${name}=${value}"`;
}

/** The text of the user unit for the record. */
export function renderUnit(record: ServiceRecord, layout: ProgramLayout): string {
    const execStart = [
        join(layout.current, "bin", "bob"),
        "serve",
        "--config-dir",
        record.configDir,
        "--state-dir",
        record.stateDir,
        "--data-dir",
        record.dataDir,
        "--runtime-dir",
        record.runtimeDir,
    ].join(" ");
    return `${[
        "[Unit]",
        "Description=The Intern",
        `ConditionPathExists=!${layout.holdFile}`,
        "",
        "[Service]",
        `ExecStart=${execStart}`,
        quoteEnvironment("PI_CODING_AGENT_DIR", record.piAgentDir),
        quoteEnvironment("PATH", record.path),
        quoteEnvironment("HOME", homeOf(layout)),
        quoteEnvironment("BOB_SERVICE_LABEL", record.label),
        "Restart=on-failure",
        "RestartSec=5",
        "StartLimitIntervalSec=0",
        "KillMode=mixed",
        "TimeoutStopSec=20",
        "",
        "[Install]",
        "WantedBy=default.target",
    ].join("\n")}\n`;
}

function detail(result: CommandResult): string {
    return (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
}

export function systemdService(
    runner: CommandRunner,
    layout: ProgramLayout,
    options: SystemdOptions = {},
): ServiceManager {
    const user = options.user ?? userInfo().username;
    const isTerminal = options.isTerminal ?? (() => process.stdin.isTTY === true);
    const unitFile = unitFilePath(layout);

    const systemctl = (...args: string[]) => runner("systemctl", ["--user", ...args]);

    async function requireSuccess(step: string, result: CommandResult): Promise<void> {
        if (result.code !== 0) throw new ServiceRefusedError(`${step} was refused: ${detail(result)}`);
    }

    async function lingerIsOn(): Promise<boolean> {
        const result = await runner("loginctl", ["show-user", user, "-p", "Linger"]);
        return result.code === 0 && result.stdout.trim() === "Linger=yes";
    }

    /** Runs a lingering command as the account, then through sudo. Returns whether it worked. */
    async function changeLinger(verb: "enable-linger" | "disable-linger"): Promise<boolean> {
        if ((await runner("loginctl", [verb])).code === 0) return true;
        const terminal = isTerminal();
        const sudoArgs = terminal ? ["loginctl", verb, user] : ["-n", "loginctl", verb, user];
        const result = await runner("sudo", sudoArgs, { stdin: terminal ? "inherit" : "ignore" });
        return result.code === 0;
    }

    async function removeUnit(): Promise<void> {
        await rm(unitFile, { force: true });
        await systemctl("daemon-reload");
    }

    return {
        async register(record, io) {
            const reach = await systemctl("show-environment");
            if (reach.code !== 0) {
                throw new ServiceRefusedError(
                    `systemctl --user can't reach the user manager (${detail(reach)}), which means this machine ` +
                        "doesn't let your account's own service run at boot; log in through a full session or ask the " +
                        "machine's administrator to enable user services",
                );
            }
            const alreadyOn = await lingerIsOn();
            if (!alreadyOn) {
                io.writeLine("Turning on lingering so the service starts at boot (admin rights may be asked).");
                if (!(await changeLinger("enable-linger"))) {
                    throw new ServiceRefusedError(
                        `admin rights were refused: turning lingering on for ${user} needs them, so the service ` +
                            "would not start at boot; run `sudo loginctl enable-linger " +
                            `${user}\` yourself or install with an account that may`,
                    );
                }
                record.lingerTurnedOn = true;
            }
            const undoLinger = async () => {
                if (!alreadyOn) await changeLinger("disable-linger");
                record.lingerTurnedOn = false;
            };
            try {
                await mkdir(dirname(unitFile), { recursive: true });
                await writeFile(unitFile, renderUnit(record, layout));
                await requireSuccess("systemctl --user daemon-reload", await systemctl("daemon-reload"));
            } catch (error) {
                await removeUnit();
                await undoLinger();
                throw error;
            }
            const enabled = await systemctl("enable", UNIT_NAME);
            if (enabled.code !== 0) {
                await removeUnit();
                await undoLinger();
                await requireSuccess("systemctl --user enable", enabled);
            }
            const started = await systemctl("start", UNIT_NAME);
            if (started.code !== 0) {
                await systemctl("disable", UNIT_NAME);
                await removeUnit();
                await undoLinger();
                await requireSuccess("systemctl --user start", started);
            }
        },

        async remove() {
            await systemctl("stop", UNIT_NAME);
            await systemctl("disable", UNIT_NAME);
            await removeUnit();
        },

        async stop() {
            await requireSuccess("systemctl --user stop", await systemctl("stop", UNIT_NAME));
        },

        async start() {
            await requireSuccess("systemctl --user start", await systemctl("start", UNIT_NAME));
        },

        async state(): Promise<ServiceState> {
            if (!(await fileExists(unitFile))) return { registered: false, startsAtBoot: false };
            const enabled = await systemctl("is-enabled", UNIT_NAME);
            const registered = enabled.stdout.trim() !== "";
            const startsAtBoot = enabled.code === 0 && (await lingerIsOn());
            return { registered, startsAtBoot };
        },

        logCommand() {
            return LOG_COMMAND;
        },
    };
}

async function fileExists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}
