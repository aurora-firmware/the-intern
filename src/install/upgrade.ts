/**
 * `bob upgrade` (S-010 REQ-006): the refusals, the confirmation and the steps that move the service to a newer version.
 * The command takes `install.lock`, finishes any operation a cut-off command left, then acts on the directories
 * `service.json` holds, never its own environment's (REQ-004). Notices and questions go to standard error. It imports
 * only the installation modules and the daemon's lock and report files (ADR-005 decision 2).
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CommandIo } from "../cli/command_line.ts";
import { writeError } from "../cli/output.ts";
import { acquireOwnership, type OwnershipHandle, readOwnerLock } from "../daemon/ownership.ts";
import { readStartupReport, removeStartupReport } from "../daemon/startup_report.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../daemon/state_layout.ts";
import {
    confirmation,
    decideUpgrade,
    nextStep,
    parseVersion,
    UPGRADE_STEPS,
    type UpgradeFacts,
    type Version,
} from "./install_model.ts";
import {
    type OperationJournal,
    type Resumers,
    removeJournal,
    type StepIo,
    stepDone,
    writeJournal,
} from "./operation_journal.ts";
import { readLink, removeVersion, switchLink } from "./program_layout.ts";
import { fetchBundle, latestVersion, releaseSource } from "./release_source.ts";
import type { ServiceCommandContext } from "./service_commands.ts";
import { withInstallLock } from "./service_commands.ts";
import { hold, readServiceRecord, type ServiceRecord, ServiceRefusedError, unhold } from "./service_manager.ts";
import { pruneCopies, takeCopy } from "./state_copy.ts";

type UpgradeStep = (typeof UPGRADE_STEPS)[number];

/** Where `bob upgrade` finds versions: the release source, or a fake in a test. */
export type ReleaseAccess = {
    latest(): Promise<string>;
    fetch(version: string, platform: string): Promise<string>;
};

export type UpgradeInput = {
    context: ServiceCommandContext;
    /** The version asked for; undefined asks for the latest release. */
    version: string | undefined;
    yes: boolean;
    release?: ReleaseAccess;
    ask?: (question: string) => Promise<boolean>;
    now?: () => Date;
    stepIo?: StepIo;
};

const STEP_NOTICES: Record<UpgradeStep, string> = {
    held: "Holding the service so it stays stopped.",
    stopped: "Stopping the service.",
    owned: "Taking ownership of the state directory.",
    copied: "Copying the database, the configuration file and the internal folder.",
    switched: "Switching to the new version.",
    released: "Starting the service.",
    ready: "Waiting for the new version to be ready.",
};

const NO_VERSION: Version = { major: 0, minor: 0, patch: 0, preRelease: [] };
const OWNED_INDEX = UPGRADE_STEPS.indexOf("owned");
const RELEASED_INDEX = UPGRADE_STEPS.indexOf("released");

/** Asks the question on standard error and reads one line of standard input; only y or yes counts as yes. */
export function askYesNo(io: CommandIo, question: string): Promise<boolean> {
    io.stderr.write(`${question} [y/N] `);
    const lines = createInterface({ input: io.stdin });
    return new Promise((resolve) => {
        lines.once("line", (line) => {
            // Resolved before closing: closing reports the input as ended, which counts as no.
            resolve(/^y(es)?$/i.test(line.trim()));
            lines.close();
        });
        lines.once("close", () => resolve(false));
    });
}

function directoriesOf(context: ServiceCommandContext, record: ServiceRecord): InstanceDirs {
    const { configDir, stateDir, dataDir, runtimeDir } = record;
    return resolveInstanceDirs({
        flags: { configDir, stateDir, dataDir, runtimeDir },
        env: context.io.env,
        homeDir: context.io.homeDir,
    });
}

type Running = {
    context: ServiceCommandContext;
    record: ServiceRecord;
    dirs: InstanceDirs;
    journal: OperationJournal;
    now: () => Date;
    stepIo?: StepIo;
};

/** Runs one step's work; the owner lock handle stays with the caller, who releases it in `released`. */
async function performStep(step: UpgradeStep, run: Running, owner: { handle: OwnershipHandle | null }): Promise<void> {
    const { context, record, dirs, journal } = run;
    const { layout } = context;
    switch (step) {
        case "held":
            await hold(layout);
            return;
        case "stopped":
            await context.managerFor(record.platform).stop(record);
            return;
        case "owned":
            owner.handle = await acquireOwnership(dirs.stateDir);
            return;
        case "copied":
            journal.copyName = await takeCopy(dirs, journal.from, journal.to, run.now());
            return;
        case "switched":
            await switchLink(layout, "previous", journal.from);
            await switchLink(layout, "current", journal.to);
            return;
        case "released":
            await removeStartupReport(dirs.stateDir);
            await owner.handle?.release();
            await unhold(layout);
            await context.managerFor(record.platform).start(record);
            return;
        case "ready": {
            const result = await context.waitForReady(record);
            if (!result.ready) {
                const reason = result.report?.reason ?? "the daemon didn't report ready";
                throw new ServiceRefusedError(
                    `Version ${journal.to} isn't ready after the upgrade: ${reason}. The upgrade is left unfinished.`,
                );
            }
        }
    }
}

/** Runs the steps after `journal.lastStep` to the end, then prunes the older copies and removes the journal. */
async function runSteps(run: Running): Promise<void> {
    const { context, dirs, journal } = run;
    const first = nextStep(UPGRADE_STEPS, journal.lastStep) as UpgradeStep | null;
    const firstIndex = first === null ? UPGRADE_STEPS.length : UPGRADE_STEPS.indexOf(first);
    const owner: { handle: OwnershipHandle | null } = { handle: null };
    // A resume after `owned` takes the lock again: the process that took it is gone.
    if (firstIndex > OWNED_INDEX && firstIndex <= RELEASED_INDEX) owner.handle = await acquireOwnership(dirs.stateDir);
    for (const step of UPGRADE_STEPS.slice(firstIndex)) {
        writeError(context.io, STEP_NOTICES[step]);
        await performStep(step, run, owner);
        await stepDone(context.layout, journal, step, run.stepIo);
    }
    if (journal.copyName !== null) await pruneCopies(dirs, journal.copyName);
    await removeJournal(context.layout);
}

/** Continues a cut-off upgrade from the step after `journal.lastStep` to its end; refuses when it isn't ready. */
export async function resumeUpgrade(
    context: ServiceCommandContext,
    journal: OperationJournal,
    options: { now?: () => Date; stepIo?: StepIo } = {},
): Promise<void> {
    const record = await readServiceRecord(context.layout);
    if (record === null) {
        throw new ServiceRefusedError("Can't finish the cut-off upgrade: the service is not registered.");
    }
    await runSteps({
        context,
        record,
        dirs: directoriesOf(context, record),
        journal,
        now: options.now ?? (() => new Date()),
        stepIo: options.stepIo,
    });
}

async function upgradeFacts(
    record: ServiceRecord | null,
    current: Version | undefined,
    asked: Version,
): Promise<UpgradeFacts> {
    const base = { currentVersion: current ?? NO_VERSION, askedVersion: asked };
    if (record === null) {
        return { hasServiceFile: false, serviceLabel: "", ownerLockPid: undefined, startupReport: undefined, ...base };
    }
    const lock = await readOwnerLock(record.stateDir);
    const report = await readStartupReport(record.stateDir);
    return {
        hasServiceFile: true,
        serviceLabel: record.label,
        ownerLockPid: lock?.pid,
        startupReport: report === undefined ? undefined : { pid: report.pid, label: report.serviceLabel ?? undefined },
        ...base,
    };
}

function releaseAccessOf(context: ServiceCommandContext): ReleaseAccess {
    const source = releaseSource(context.io.env);
    return {
        latest: () => latestVersion(source),
        fetch: (version, platform) => fetchBundle(source, context.layout, version, platform),
    };
}

/** The upgrade proper, after any cut-off operation was finished. */
async function decideAndRun(input: UpgradeInput): Promise<number> {
    const { context } = input;
    const { io, layout } = context;
    const record = await readServiceRecord(layout);
    const currentText = await readLink(layout, "current");
    if (record !== null && currentText === null) {
        writeError(io, "Can't upgrade: no version is installed as the current one.");
        return 1;
    }
    const release = input.release ?? releaseAccessOf(context);
    const askedText = record === null ? "0.0.0" : (input.version ?? (await release.latest()));
    const asked = parseVersion(askedText);
    if (asked === undefined) {
        writeError(io, `Can't upgrade: "${askedText}" is not a version of the form X.Y.Z.`);
        return 1;
    }
    const current = currentText === null ? undefined : parseVersion(currentText);
    const decision = decideUpgrade(await upgradeFacts(record, current, asked));
    if (decision.kind === "refuse") {
        writeError(io, `Can't upgrade: ${decision.reason}.`);
        return 1;
    }
    if (decision.kind === "already") {
        writeError(io, `Already on version ${askedText}.`);
        return 0;
    }
    return confirmAndUpgrade(input, release, record as ServiceRecord, currentText as string, askedText);
}

async function confirmAndUpgrade(
    input: UpgradeInput,
    release: ReleaseAccess,
    record: ServiceRecord,
    from: string,
    to: string,
): Promise<number> {
    const { context } = input;
    const { io, layout } = context;
    const mode = confirmation({ yes: input.yes, isStdinTerminal: io.isStdinTerminal });
    if (mode === "declined") {
        writeError(io, "Can't ask to upgrade: standard input isn't a terminal; give --yes to confirm.");
        return 1;
    }
    const downloaded = !existsSync(layout.versionDir(to));
    if (downloaded) await release.fetch(to, record.platform);
    if (mode === "ask") {
        const ask = input.ask ?? ((question) => askYesNo(io, question));
        if (!(await ask(`Stop the service and upgrade from ${from} to ${to}?`))) {
            if (downloaded) await removeVersion(layout, to);
            writeError(io, "Upgrade declined; nothing was changed.");
            return 1;
        }
    }
    const journal: OperationJournal = {
        format: 1,
        operation: "upgrade",
        from,
        to,
        copyName: null,
        setAsideName: null,
        currentBefore: from,
        previousBefore: await readLink(layout, "previous"),
        lastStep: null,
    };
    await writeJournal(layout, journal);
    await runSteps({
        context,
        record,
        dirs: directoriesOf(context, record),
        journal,
        now: input.now ?? (() => new Date()),
        stepIo: input.stepIo,
    });
    return 0;
}

/**
 * Runs `bob upgrade`: 0 when the service is on the asked version and ready, 1 with the reason on standard error for a
 * refusal, a declined question or any failure on the way.
 */
export async function runUpgrade(input: UpgradeInput): Promise<number> {
    const { context } = input;
    let finishedTo: string | undefined;
    const resumers: Resumers = {
        ...context.resumers,
        upgrade: async (journal) => {
            await context.resumers.upgrade(journal);
            finishedTo = journal.to;
        },
    };
    try {
        return await withInstallLock(context.layout, "upgrade", resumers, async () => {
            // A cut-off upgrade to the asked version has now been finished: that is where this one ends.
            if (finishedTo !== undefined && finishedTo === input.version) return 0;
            return decideAndRun(input);
        });
    } catch (error) {
        writeError(context.io, error instanceof Error ? error.message : String(error));
        return 1;
    }
}
