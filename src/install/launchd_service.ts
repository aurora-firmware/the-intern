/**
 * The macOS service manager (ADR-012 decisions 1, 3 and 4): a LaunchDaemon in the system domain that runs as the
 * service account, so the service starts at boot with nobody logged in. The supervisor's commands go through the
 * injected command runner; the plist is rendered by a pure function. Stopping and starting use the hold file and the
 * owner lock, so neither needs admin rights.
 */
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { readOwnerLock } from "../daemon/ownership.ts";
import type { ProgramLayout } from "./program_layout.ts";
import {
    type CommandResult,
    type CommandRunner,
    hold,
    type ServiceManager,
    type ServiceRecord,
    ServiceRefusedError,
    type ServiceState,
    unhold,
} from "./service_manager.ts";

const LABEL = "com.aurora-firmware.the-intern";
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;
const SERVICE_LOG_NAME = "service.log";
const OWNER_ONLY_FILE_MODE = 0o600;
const PROGRAM_FOLDER_DEPTH = 3;
const STOP_POLL_MS = 50;
const STOP_TIMEOUT_MS = 30_000;

export type LaunchdOptions = {
    /** The account the daemon runs as. Defaults to the current account. */
    userName?: string;
    /** Where the plist lives. Defaults to the system's LaunchDaemons folder. */
    plistPath?: string;
    /** Whether `sudo` may ask for a password on a terminal. Defaults to whether standard input is one. */
    isTerminal?: () => boolean;
    /** How long `stop` waits for the owner lock to be released. */
    stopTimeoutMs?: number;
};

/** The home directory the program folder `<home>/.local/lib/the-intern` lies under. */
function homeOf(layout: ProgramLayout): string {
    let home = layout.root;
    for (let level = 0; level < PROGRAM_FOLDER_DEPTH; level += 1) home = dirname(home);
    return home;
}

function escapeXml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function stringValue(text: string): string {
    return `<string>${escapeXml(text)}</string>`;
}

function entries(pairs: [string, string][], indent: string): string[] {
    return pairs.flatMap(([key, value]) => [`${indent}<key>${escapeXml(key)}</key>`, `${indent}${value}`]);
}

/** The text of the LaunchDaemon plist for the record. */
export function renderPlist(record: ServiceRecord, layout: ProgramLayout, userName: string): string {
    const programArguments = [
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
    ];
    const environment: [string, string][] = [
        ["PI_CODING_AGENT_DIR", stringValue(record.piAgentDir)],
        ["PATH", stringValue(record.path)],
        ["HOME", stringValue(homeOf(layout))],
        ["BOB_SERVICE_LABEL", stringValue(record.label)],
    ];
    return `${[
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        ...entries(
            [
                ["Label", stringValue(record.label)],
                ["UserName", stringValue(userName)],
            ],
            "    ",
        ),
        "    <key>ProgramArguments</key>",
        "    <array>",
        ...programArguments.map((argument) => `        ${stringValue(argument)}`),
        "    </array>",
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        ...entries(environment, "        "),
        "    </dict>",
        ...entries(
            [
                ["RunAtLoad", "<true/>"],
                ["StandardErrorPath", stringValue(join(record.stateDir, SERVICE_LOG_NAME))],
            ],
            "    ",
        ),
        "    <key>KeepAlive</key>",
        "    <dict>",
        "        <key>PathState</key>",
        "        <dict>",
        ...entries([[layout.holdFile, "<false/>"]], "            "),
        "        </dict>",
        "    </dict>",
        "</dict>",
        "</plist>",
    ].join("\n")}\n`;
}

const INSTALL_SCRIPT =
    '/usr/bin/install -m 0644 -o root -g wheel "$1" "$2" && launchctl bootstrap system "$2" || { rm -f "$2"; exit 1; }';
const REPLACE_SCRIPT = `launchctl bootout system/${LABEL} 2>/dev/null; ${INSTALL_SCRIPT}`;
const REMOVE_SCRIPT = `launchctl bootout system/${LABEL}; rm -f "$2"`;

function detail(result: CommandResult): string {
    return (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
}

async function fileExists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

function userNameOf(plist: string): string | undefined {
    return /<key>UserName<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
}

export function launchdService(
    runner: CommandRunner,
    layout: ProgramLayout,
    options: LaunchdOptions = {},
): ServiceManager {
    const userName = options.userName ?? userInfo().username;
    const plistPath = options.plistPath ?? PLIST_PATH;
    const isTerminal = options.isTerminal ?? (() => process.stdin.isTTY === true);
    const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;

    /** One `sudo /bin/sh -c` call. `$1` is the source file, and `$2` the plist. */
    async function sudoShell(script: string, source: string, step: string): Promise<void> {
        const terminal = isTerminal();
        const args = ["/bin/sh", "-c", script, "sh", source, plistPath];
        const result = await runner("sudo", terminal ? args : ["-n", ...args], {
            stdin: terminal ? "inherit" : "ignore",
        });
        if (result.code !== 0) {
            throw new ServiceRefusedError(
                `admin rights were refused or ${step} failed (${detail(result)}): it needs them, so nothing was ` +
                    "registered; run it from an account that may use sudo",
            );
        }
    }

    async function createServiceLog(logPath: string): Promise<boolean> {
        const existed = await fileExists(logPath);
        const file = await open(logPath, "a", OWNER_ONLY_FILE_MODE);
        await file.close();
        return !existed;
    }

    return {
        async register(record) {
            const existing = await readFile(plistPath, "utf8").then(
                (text) => text,
                () => undefined,
            );
            if (existing !== undefined) {
                const owner = userNameOf(existing);
                if (owner !== userName) {
                    throw new ServiceRefusedError(
                        `${plistPath} already registers the service for the account ${owner ?? "(unknown)"}, and ` +
                            `one machine holds one registration; remove it with that account first, not ${userName}`,
                    );
                }
            }
            const logPath = join(record.stateDir, SERVICE_LOG_NAME);
            const createdLog = await createServiceLog(logPath);
            const folder = await mkdtemp(join(tmpdir(), "the-intern-plist-"));
            try {
                const source = join(folder, `${LABEL}.plist`);
                await writeFile(source, renderPlist(record, layout, userName), { mode: OWNER_ONLY_FILE_MODE });
                await sudoShell(
                    existing === undefined ? INSTALL_SCRIPT : REPLACE_SCRIPT,
                    source,
                    "installing the plist",
                );
            } catch (error) {
                if (createdLog) await rm(logPath, { force: true });
                throw error;
            } finally {
                await rm(folder, { recursive: true, force: true });
            }
        },

        async remove() {
            await sudoShell(REMOVE_SCRIPT, "", "removing the plist");
        },

        async stop(record) {
            await hold(layout);
            const lock = await readOwnerLock(record.stateDir);
            if (lock === undefined) return;
            process.kill(lock.pid, "SIGTERM");
            const deadline = Date.now() + stopTimeoutMs;
            while ((await readOwnerLock(record.stateDir)) !== undefined) {
                if (Date.now() > deadline) {
                    throw new ServiceRefusedError(
                        `the service (pid ${lock.pid}) did not release ${record.stateDir} within ` +
                            `${stopTimeoutMs / 1000} seconds after SIGTERM; look at ${join(record.stateDir, SERVICE_LOG_NAME)}`,
                    );
                }
                await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
            }
        },

        async start() {
            await unhold(layout);
        },

        async state(): Promise<ServiceState> {
            if (!(await fileExists(plistPath))) return { registered: false, startsAtBoot: false };
            const disabled = await runner("launchctl", ["print-disabled", "system"]);
            const isDisabled = new RegExp(`"${LABEL}"\\s*=>\\s*(?:disabled|true)`).test(disabled.stdout);
            return { registered: true, startsAtBoot: !isDisabled };
        },

        logCommand(record) {
            return `tail -n 100 ${join(record.stateDir, SERVICE_LOG_NAME)}`;
        },
    };
}
