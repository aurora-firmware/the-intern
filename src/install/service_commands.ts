/**
 * The steps of `bob service install`, `remove` and `status` (S-010 REQ-004, REQ-005). Every command but `status` runs
 * under `install.lock` and first finishes an operation another command left cut off. Notices, questions and errors go
 * to standard error; only `status` writes to standard output. It imports the client library, the service layer and the
 * installation modules, never a pi package (ADR-005 decision 2).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandIo } from "../cli/command_line.ts";
import { writeError, writeJson, writeLine } from "../cli/output.ts";
import { acquireInstallLock, InstallLockRefusedError } from "../daemon/ownership.ts";
import { resolveInstanceDirs } from "../daemon/state_layout.ts";
import { checkPlatform, type PlatformFacts } from "./install_model.ts";
import { launchdService } from "./launchd_service.ts";
import { finishCutOffOperation, OperationJournalError, type Resumers, readJournal } from "./operation_journal.ts";
import { checkLayout, type ProgramLayout, ProgramLayoutError, programLayout, readLink } from "./program_layout.ts";
import { type ReadyWaitResult, readRunningVersion, waitForReady } from "./ready_wait.ts";
import {
    type CommandRunner,
    nodeCommandRunner,
    readServiceRecord,
    removeServiceRecord,
    type ServiceManager,
    type ServiceRecord,
    ServiceRecordError,
    ServiceRefusedError,
    unhold,
    writeServiceRecord,
} from "./service_manager.ts";
import { systemdService } from "./systemd_service.ts";

type Platform = ServiceRecord["platform"];

/** The labels the two service managers register under; each module keeps its own copy private. */
const SERVICE_LABELS: Record<Platform, string> = {
    "linux-x64": "the-intern.service",
    "darwin-arm64": "com.aurora-firmware.the-intern",
};

/** How long `status` waits for the daemon's answer before it reports the service as not running. */
const STATUS_ANSWER_MS = 5_000;

export type ServiceCommandContext = {
    io: CommandIo;
    layout: ProgramLayout;
    facts: PlatformFacts;
    managerFor: (platform: Platform) => ServiceManager;
    resumers: Resumers;
    waitForReady: (record: ServiceRecord) => Promise<ReadyWaitResult>;
    readVersion: (record: ServiceRecord) => Promise<string | null>;
    versionTimeoutMs: number;
};

export function serviceManagerFor(platform: Platform, runner: CommandRunner, layout: ProgramLayout): ServiceManager {
    return platform === "linux-x64" ? systemdService(runner, layout) : launchdService(runner, layout);
}

function processFacts(): PlatformFacts {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return {
        platform: process.platform,
        arch: process.arch,
        hasGlibc: report?.header?.glibcVersionRuntime !== undefined,
        hasSystemd: existsSync("/run/systemd/system"),
        uid: process.getuid?.() ?? -1,
    };
}

/** The context a `bob` process runs the commands with: its own home, platform and the real supervisor commands. */
export function serviceCommandContext(io: CommandIo, resumers: Resumers): ServiceCommandContext {
    const layout = programLayout(io.homeDir);
    return {
        io,
        layout,
        facts: processFacts(),
        managerFor: (platform) => serviceManagerFor(platform, nodeCommandRunner, layout),
        resumers,
        waitForReady: (record) => waitForReady(record),
        readVersion: readRunningVersion,
        versionTimeoutMs: STATUS_ANSWER_MS,
    };
}

/** Runs the work holding `install.lock`, after finishing any operation a cut-off command left. Refuses while another holds it. */
export async function withInstallLock<T>(
    layout: ProgramLayout,
    commandName: string,
    resumers: Resumers,
    work: () => Promise<T>,
): Promise<T> {
    const handle = await acquireInstallLock(layout.root, commandName);
    try {
        await finishCutOffOperation(layout, resumers);
        return await work();
    } finally {
        await handle.release();
    }
}

/** Runs the steps and turns a refusal the team member can act on into its message and exit 1. */
async function reportingRefusals(io: CommandIo, steps: () => Promise<number>): Promise<number> {
    try {
        return await steps();
    } catch (error) {
        if (error instanceof InstallLockRefusedError) {
            writeError(io, `Another installation command is running: ${error.message}. Wait for it to end.`);
            return 1;
        }
        if (
            error instanceof ProgramLayoutError ||
            error instanceof ServiceRecordError ||
            error instanceof ServiceRefusedError ||
            error instanceof OperationJournalError
        ) {
            writeError(io, error.message);
            return 1;
        }
        throw error;
    }
}

function newRecord(context: ServiceCommandContext, platform: Platform): ServiceRecord {
    const { env, homeDir } = context.io;
    const dirs = resolveInstanceDirs({ flags: {}, env, homeDir });
    return {
        format: 1,
        platform,
        label: SERVICE_LABELS[platform],
        configDir: dirs.configDir,
        stateDir: dirs.stateDir,
        dataDir: dirs.dataDir,
        runtimeDir: dirs.runtimeDir,
        piAgentDir: resolve(env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent")),
        path: env.PATH ?? "",
        lingerTurnedOn: false,
    };
}

/** The record the registration uses: the earlier one's directories and pi folder when there is one. */
function registrationRecord(
    context: ServiceCommandContext,
    platform: Platform,
    earlier: ServiceRecord | null,
): ServiceRecord {
    const fresh = newRecord(context, platform);
    if (earlier === null) return fresh;
    return { ...earlier, platform, label: fresh.label, path: fresh.path };
}

function notReadyReason(result: Extract<ReadyWaitResult, { ready: false }>): string {
    const { report } = result;
    if (report === undefined) return "the daemon wrote no startup report";
    if (report.reason !== null) return report.reason;
    return "the daemon didn't report ready";
}

async function installSteps(context: ServiceCommandContext): Promise<number> {
    const { io, layout } = context;
    const check = checkPlatform(context.facts);
    if (!check.ok) {
        writeError(io, `Can't install the service: ${check.reason}.`);
        return 1;
    }
    const earlier = await readServiceRecord(layout);
    const record = registrationRecord(context, check.platform, earlier);
    checkLayout(layout, [record.configDir, record.stateDir, record.dataDir, record.runtimeDir]);
    const manager = context.managerFor(check.platform);
    await writeServiceRecord(layout, record);
    try {
        await manager.register(record, { writeLine: (text) => writeError(io, text) });
    } catch (error) {
        if (earlier === null) await removeServiceRecord(layout);
        else await writeServiceRecord(layout, earlier);
        throw error;
    }
    await writeServiceRecord(layout, record);
    const result = await context.waitForReady(record);
    if (result.ready) return 0;
    writeError(
        io,
        `The service is registered, but the daemon isn't ready: ${notReadyReason(result)}.\n` +
            `Its log: ${manager.logCommand(record)}`,
    );
    return 1;
}

export function runServiceInstall(context: ServiceCommandContext): Promise<number> {
    return reportingRefusals(context.io, () =>
        withInstallLock(context.layout, "service install", context.resumers, () => installSteps(context)),
    );
}

async function removeSteps(context: ServiceCommandContext): Promise<number> {
    const { io, layout } = context;
    const record = await readServiceRecord(layout);
    if (record === null) {
        writeError(io, "No service is registered.");
    } else {
        const manager = context.managerFor(record.platform);
        await manager.stop(record);
        await manager.remove(record, { writeLine: (text) => writeError(io, text) });
        await removeServiceRecord(layout);
    }
    await unhold(layout);
    return 0;
}

export function runServiceRemove(context: ServiceCommandContext): Promise<number> {
    return reportingRefusals(context.io, () =>
        withInstallLock(context.layout, "service remove", context.resumers, () => removeSteps(context)),
    );
}

/** The daemon's version, or null when it doesn't answer within `ms`: a silent daemon can't hold `status` up. */
async function versionWithin(context: ServiceCommandContext, record: ServiceRecord): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<null>((resolveExpiry) => {
        timer = setTimeout(() => resolveExpiry(null), context.versionTimeoutMs);
    });
    try {
        return await Promise.race([context.readVersion(record).catch(() => null), expiry]);
    } finally {
        clearTimeout(timer);
    }
}

type StatusView = {
    registered: boolean;
    startsAtBoot: boolean;
    running: boolean;
    version: string | null;
    configDir: string | null;
    stateDir: string | null;
    dataDir: string | null;
    runtimeDir: string | null;
    piAgentDir: string | null;
};

async function statusView(context: ServiceCommandContext): Promise<StatusView> {
    const record = await readServiceRecord(context.layout);
    const state = record === null ? undefined : await context.managerFor(record.platform).state(record);
    if (record === null || state === undefined || !state.registered) {
        return {
            registered: false,
            startsAtBoot: false,
            running: false,
            version: null,
            configDir: null,
            stateDir: null,
            dataDir: null,
            runtimeDir: null,
            piAgentDir: null,
        };
    }
    const version = await versionWithin(context, record);
    return {
        registered: true,
        startsAtBoot: state.startsAtBoot,
        running: version !== null,
        version,
        configDir: record.configDir,
        stateDir: record.stateDir,
        dataDir: record.dataDir,
        runtimeDir: record.runtimeDir,
        piAgentDir: record.piAgentDir,
    };
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

async function statusText(context: ServiceCommandContext, view: StatusView): Promise<string[]> {
    const { layout } = context;
    const lines = [
        `Registered: ${yesNo(view.registered)}`,
        `Starts at boot: ${yesNo(view.startsAtBoot)}`,
        `Running: ${view.running ? `yes (version ${view.version})` : "no"}`,
        `Current version: ${(await readLink(layout, "current")) ?? "none"}`,
        `Previous version: ${(await readLink(layout, "previous")) ?? "none"}`,
        `Held: ${yesNo(existsSync(layout.holdFile))}`,
    ];
    const journal = await readJournal(layout);
    if (journal !== null) {
        const after = journal.lastStep === null ? "before its first step" : `after ${journal.lastStep}`;
        lines.push(`Cut off: ${journal.operation} from ${journal.from} to ${journal.to} was cut off ${after}`);
    }
    const directories: [string, string | null][] = [
        ["Config directory", view.configDir],
        ["State directory", view.stateDir],
        ["Data directory", view.dataDir],
        ["Runtime directory", view.runtimeDir],
        ["Pi agent folder", view.piAgentDir],
    ];
    for (const [label, value] of directories) if (value !== null) lines.push(`${label}: ${value}`);
    return lines;
}

/** Takes no lock and changes nothing; exits 0 in every state of the service. */
export function runServiceStatus(context: ServiceCommandContext, options: { json: boolean }): Promise<number> {
    return reportingRefusals(context.io, async () => {
        const view = await statusView(context);
        if (options.json) writeJson(context.io, view);
        else for (const line of await statusText(context, view)) writeLine(context.io, line);
        return 0;
    });
}
