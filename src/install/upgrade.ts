/**
 * `bob upgrade` (S-010 REQ-006): the refusals, the confirmation and the steps that move the service to a newer version.
 * The command takes `install.lock`, finishes any operation a cut-off command left, then acts on the directories
 * `service.json` holds, never its own environment's (REQ-004). Notices and questions go to standard error. It imports
 * only the installation modules and the daemon's lock and report files (ADR-005 decision 2).
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CommandIo } from "../cli/command_line.ts";
import { writeError } from "../cli/output.ts";
import { acquireOwnership, type OwnershipHandle, readOwnerLock } from "../daemon/ownership.ts";
import { readStartupReport, removeStartupReport, type StartupReport } from "../daemon/startup_report.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../daemon/state_layout.ts";
import {
    classifyStartup,
    confirmation,
    decideUpgrade,
    FRESH_START_STEPS,
    nextStep,
    parseVersion,
    SWITCH_BACK_STEPS,
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
import {
    INTERNAL_PARTS,
    importCopy,
    markKept,
    pruneCopies,
    restoreConfig,
    restoreInternal,
    setAside,
    takeCopy,
    upgradesDir,
} from "./state_copy.ts";

type StepOperation = "upgrade" | "switch-back" | "fresh-start";

const OPERATION_STEPS: Record<StepOperation, readonly string[]> = {
    upgrade: UPGRADE_STEPS,
    "switch-back": SWITCH_BACK_STEPS,
    "fresh-start": FRESH_START_STEPS,
};

/** Where `bob upgrade` finds versions: the release source, or a fake in a test. */
export type ReleaseAccess = {
    latest(): Promise<string>;
    fetch(version: string, platform: string): Promise<string>;
};

/** Asks a yes-or-no question; `defaultYes` is what an empty answer means. */
export type Ask = (question: string, defaultYes: boolean) => Promise<boolean>;

export type UpgradeInput = {
    context: ServiceCommandContext;
    /** The version asked for; undefined asks for the latest release. */
    version: string | undefined;
    yes: boolean;
    release?: ReleaseAccess;
    ask?: Ask;
    now?: () => Date;
    stepIo?: StepIo;
};

const STEP_NOTICES: Record<string, string> = {
    held: "Holding the service so it stays stopped.",
    stopped: "Stopping the service.",
    owned: "Taking ownership of the state directory.",
    copied: "Copying the database, the configuration file and the internal folder.",
    switched: "Switching to the new version.",
    released: "Starting the service.",
    ready: "Waiting for the version to be ready.",
    "set-aside": "Setting the database aside.",
    imported: "Restoring the database from the copy.",
    restored: "Putting back the configuration file and the internal folder.",
    kept: "Keeping the pre-upgrade copy.",
    removed: "Removing the version that failed.",
};

const NO_VERSION: Version = { major: 0, minor: 0, patch: 0, preRelease: [] };

/**
 * Asks the question on standard error and reads one line of standard input. y or yes is yes, n or no is no, and an
 * empty line, any other answer or a closed input is the default.
 */
export function askYesNo(io: CommandIo, question: string, defaultYes = false): Promise<boolean> {
    io.stderr.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
    const lines = createInterface({ input: io.stdin });
    return new Promise((resolve) => {
        lines.once("line", (line) => {
            const answer = line.trim();
            // Resolved before closing: closing reports the input as ended, which counts as the default.
            resolve(/^y(es)?$/i.test(answer) || (defaultYes && !/^n(o)?$/i.test(answer)));
            lines.close();
        });
        lines.once("close", () => resolve(defaultYes));
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
    ask: Ask;
};

/** Why a new version isn't ready, and whether its startup got as far as opening the database. */
type NotReady = { reason: string; isUnreadable: boolean; hasOpenedDatabase: boolean };

const UNREADABLE_REPORT_REASON = "the startup report can't be read";
const UNANSWERED_REASON = "the daemon reported ready but didn't answer daemon.status";

function describeNotReady(report: StartupReport | undefined): NotReady {
    const classification = classifyStartup(report);
    switch (classification.kind) {
        case "unreadable":
            return { reason: classification.reason, isUnreadable: true, hasOpenedDatabase: false };
        case "failed":
            return {
                reason: classification.reason,
                isUnreadable: false,
                hasOpenedDatabase: classification.databaseOpened,
            };
        case "ready":
            return { reason: UNANSWERED_REASON, isUnreadable: false, hasOpenedDatabase: true };
    }
}

/** Whether the failed version's startup reached the database; unknown counts as yes, as restoring the copy is safe. */
async function hasOpenedDatabase(stateDir: string): Promise<boolean> {
    try {
        return describeNotReady(await readStartupReport(stateDir)).hasOpenedDatabase;
    } catch {
        return true;
    }
}

/** Waits for ready; null when it is, else why not. Any failure to wait or to read the report is a reason too. */
async function waitUntilReady(run: Running): Promise<NotReady | null> {
    let result: Awaited<ReturnType<ServiceCommandContext["waitForReady"]>>;
    try {
        result = await run.context.waitForReady(run.record);
    } catch (error) {
        const reason = `${UNREADABLE_REPORT_REASON}: ${error instanceof Error ? error.message : String(error)}`;
        return { reason, isUnreadable: false, hasOpenedDatabase: true };
    }
    return result.ready ? null : describeNotReady(result.report);
}

async function releaseVersion(run: Running, owner: { handle: OwnershipHandle | null }): Promise<void> {
    const { context, record, dirs } = run;
    await removeStartupReport(dirs.stateDir);
    await owner.handle?.release();
    await unhold(context.layout);
    await context.managerFor(record.platform).start(record);
}

async function setAsideStep(run: Running): Promise<void> {
    const { dirs, journal } = run;
    if (journal.operation === "fresh-start") {
        journal.setAsideName = await setAside(dirs, journal.to, "unreadable", run.now());
    } else if (await hasOpenedDatabase(dirs.stateDir)) {
        journal.setAsideName = await setAside(dirs, journal.to, "failed-upgrade", run.now());
    }
}

/** The failed version's own copy goes once it has served: the earlier one is the one `bob rollback` reaches. */
async function removeFailedVersion(run: Running): Promise<void> {
    const { dirs, journal, context } = run;
    await removeVersion(context.layout, journal.to);
    if (journal.copyName !== null) {
        await rm(join(upgradesDir(dirs.stateDir), journal.copyName), { recursive: true, force: true });
    }
}

async function restoredStep(run: Running): Promise<void> {
    const { dirs, journal } = run;
    const copyName = journal.copyName as string;
    await restoreConfig(dirs, copyName, `${copyName}-config-of-${journal.to}`);
    for (const part of INTERNAL_PARTS) await restoreInternal(dirs, copyName, part);
}

/** Runs one step's work; the owner lock handle stays with the caller, who releases it in `released`. */
async function performStep(step: string, run: Running, owner: { handle: OwnershipHandle | null }): Promise<void> {
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
        case "set-aside":
            await setAsideStep(run);
            return;
        case "switched":
            if (journal.operation === "switch-back") {
                await switchLink(layout, "current", journal.from);
                await switchLink(layout, "previous", journal.previousBefore);
                return;
            }
            await switchLink(layout, "previous", journal.from);
            await switchLink(layout, "current", journal.to);
            return;
        case "imported":
            if (journal.setAsideName !== null) {
                await importCopy(layout, journal.from, dirs, journal.copyName as string, owner.handle?.token ?? "");
            }
            return;
        case "restored":
            await restoredStep(run);
            return;
        case "kept":
            await markKept(dirs, journal.copyName as string);
            return;
        case "released":
            await releaseVersion(run, owner);
            return;
        case "removed":
            await removeFailedVersion(run);
    }
}

/**
 * Runs the steps after `journal.lastStep` to the end. An upgrade then prunes the older copies and removes the journal;
 * its not-ready outcome is returned instead, with the journal left at `released`. The other operations refuse when
 * the version they start isn't ready.
 */
async function runSteps(run: Running): Promise<NotReady | null> {
    const { context, dirs, journal } = run;
    const steps = OPERATION_STEPS[journal.operation as StepOperation];
    const first = nextStep(steps, journal.lastStep);
    const firstIndex = first === null ? steps.length : steps.indexOf(first);
    const owner: { handle: OwnershipHandle | null } = { handle: null };
    // A resume after `owned` takes the lock again: the process that took it is gone.
    if (firstIndex > steps.indexOf("owned") && firstIndex <= steps.indexOf("released")) {
        owner.handle = await acquireOwnership(dirs.stateDir);
    }
    for (const step of steps.slice(firstIndex)) {
        writeError(context.io, STEP_NOTICES[step]);
        if (step === "ready") {
            const notReady = await waitUntilReady(run);
            if (notReady !== null && journal.operation === "upgrade") return notReady;
            if (notReady !== null) {
                throw new ServiceRefusedError(
                    `Version ${journal.operation === "switch-back" ? journal.from : journal.to} isn't ready after the ${journal.operation}: ${notReady.reason}. The ${journal.operation} is left unfinished.`,
                );
            }
        } else {
            await performStep(step, run, owner);
        }
        await stepDone(context.layout, journal, step, run.stepIo);
    }
    if (journal.operation === "upgrade" && journal.copyName !== null) await pruneCopies(dirs, journal.copyName);
    await removeJournal(context.layout);
    return null;
}

function keptPaths(run: Running): string {
    const { dirs, journal } = run;
    const folder = (name: string | null) => join(upgradesDir(dirs.stateDir), name ?? "");
    return `The database set aside: ${folder(journal.setAsideName)}\nThe pre-upgrade copy kept: ${folder(journal.copyName)}`;
}

/** The new version started on a fresh database: nothing more to do but to say where the old data is. */
async function freshStart(run: Running): Promise<void> {
    run.journal.operation = "fresh-start";
    run.journal.lastStep = null;
    await writeJournal(run.context.layout, run.journal);
    await runSteps(run);
    writeError(run.context.io, keptPaths(run));
}

/** Switches back and ends the failed upgrade with the reason: the command exits 1 on it. */
async function switchBack(run: Running, notReady: NotReady): Promise<never> {
    run.journal.operation = "switch-back";
    run.journal.lastStep = null;
    await writeJournal(run.context.layout, run.journal);
    await runSteps(run);
    throw new ServiceRefusedError(
        `Version ${run.journal.to} failed: ${notReady.reason}. Switched back to version ${run.journal.from}.`,
    );
}

/** The upgrade's version isn't ready: REQ-008's question when its database is unreadable, else REQ-007's switch-back. */
async function handleNotReady(run: Running, notReady: NotReady): Promise<void> {
    const { context, journal } = run;
    if (!notReady.isUnreadable) {
        writeError(context.io, `Version ${journal.to} didn't become ready: ${notReady.reason}.`);
        return switchBack(run, notReady);
    }
    writeError(context.io, `Version ${journal.to} can't read the database: ${notReady.reason}.`);
    const isSwitchingBack = !context.io.isStdinTerminal || (await run.ask(`Switch back to ${journal.from}?`, true));
    if (isSwitchingBack) return switchBack(run, notReady);
    return freshStart(run);
}

/** Runs the upgrade's steps and, when its version isn't ready, the branch that follows; resolves when it ended well. */
async function runUpgradeSteps(run: Running): Promise<void> {
    const notReady = await runSteps(run);
    if (notReady !== null) await handleNotReady(run, notReady);
}

function runningFor(
    context: ServiceCommandContext,
    record: ServiceRecord,
    journal: OperationJournal,
    options: { now?: () => Date; stepIo?: StepIo; ask?: Ask },
): Running {
    return {
        context,
        record,
        dirs: directoriesOf(context, record),
        journal,
        now: options.now ?? (() => new Date()),
        stepIo: options.stepIo,
        ask: options.ask ?? ((question, defaultYes) => askYesNo(context.io, question, defaultYes)),
    };
}

type ResumeOptions = { now?: () => Date; stepIo?: StepIo; ask?: Ask };

async function resume(
    context: ServiceCommandContext,
    journal: OperationJournal,
    options: ResumeOptions,
    run: (running: Running) => Promise<void>,
): Promise<void> {
    const record = await readServiceRecord(context.layout);
    if (record === null) {
        throw new ServiceRefusedError(`Can't finish the cut-off ${journal.operation}: the service is not registered.`);
    }
    await run(runningFor(context, record, journal, options));
}

/** Continues a cut-off upgrade from the step after `journal.lastStep`; a version that isn't ready is handled as in a new one. */
export function resumeUpgrade(
    context: ServiceCommandContext,
    journal: OperationJournal,
    options: ResumeOptions = {},
): Promise<void> {
    return resume(context, journal, options, runUpgradeSteps);
}

/** Continues a cut-off switch-back from the step after `journal.lastStep`, then ends the failed upgrade with a refusal. */
export function resumeSwitchBack(
    context: ServiceCommandContext,
    journal: OperationJournal,
    options: ResumeOptions = {},
): Promise<void> {
    return resume(context, journal, options, async (run) => {
        await runSteps(run);
        throw new ServiceRefusedError(
            `The upgrade to version ${journal.to} failed and was switched back to version ${journal.from}.`,
        );
    });
}

/** Continues a cut-off fresh start from the step after `journal.lastStep`. */
export function resumeFreshStart(
    context: ServiceCommandContext,
    journal: OperationJournal,
    options: ResumeOptions = {},
): Promise<void> {
    return resume(context, journal, options, async (run) => {
        await runSteps(run);
        writeError(context.io, keptPaths(run));
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
        const ask = input.ask ?? ((question, defaultYes) => askYesNo(io, question, defaultYes));
        if (!(await ask(`Stop the service and upgrade from ${from} to ${to}?`, false))) {
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
    await runUpgradeSteps(
        runningFor(context, record, journal, { now: input.now, stepIo: input.stepIo, ask: input.ask }),
    );
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
