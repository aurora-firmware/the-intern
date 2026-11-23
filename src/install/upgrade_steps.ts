/**
 * The step engine of `bob upgrade` and of the operations it ends in (S-010 REQ-006 to REQ-008): it runs the steps of
 * an upgrade, a switch-back or a fresh start after `journal.lastStep`, recording each in the journal. It imports only
 * the installation modules and the daemon's lock and report files (ADR-005 decision 2).
 */
import { createInterface } from "node:readline";
import type { CommandIo } from "../cli/command_line.ts";
import { writeError } from "../cli/output.ts";
import { acquireOwnership, type OwnershipHandle } from "../daemon/ownership.ts";
import { readStartupReport, removeStartupReport, type StartupReport } from "../daemon/startup_report.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../daemon/state_layout.ts";
import { classifyStartup, FRESH_START_STEPS, nextStep, SWITCH_BACK_STEPS, UPGRADE_STEPS } from "./install_model.ts";
import { type OperationJournal, removeJournal, type StepIo, stepDone } from "./operation_journal.ts";
import { removeVersion, switchLink } from "./program_layout.ts";
import type { ServiceCommandContext } from "./service_commands.ts";
import { hold, type ServiceRecord, ServiceRefusedError, unhold } from "./service_manager.ts";
import {
    INTERNAL_PARTS,
    importCopy,
    markKept,
    pruneCopies,
    restoreConfig,
    restoreInternal,
    setAside,
    takeCopy,
} from "./state_copy.ts";

/** Asks a yes-or-no question; `defaultYes` is what an empty answer means. */
export type Ask = (question: string, defaultYes: boolean) => Promise<boolean>;

type StepOperation = "upgrade" | "switch-back" | "fresh-start";

const OPERATION_STEPS: Record<StepOperation, readonly string[]> = {
    upgrade: UPGRADE_STEPS,
    "switch-back": SWITCH_BACK_STEPS,
    "fresh-start": FRESH_START_STEPS,
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

export type Running = {
    context: ServiceCommandContext;
    record: ServiceRecord;
    dirs: InstanceDirs;
    journal: OperationJournal;
    now: () => Date;
    stepIo?: StepIo;
    ask: Ask;
};

/** Why a new version isn't ready, and whether its startup got as far as opening the database. */
export type NotReady = { reason: string; isUnreadable: boolean; hasOpenedDatabase: boolean };

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

/** Removes only the failed version: every copy and set-aside database stays (S-010 REQ-007, REQ-012). */
async function removeFailedVersion(run: Running): Promise<void> {
    await removeVersion(run.context.layout, run.journal.to);
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
export async function runSteps(run: Running): Promise<NotReady | null> {
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

export function runningFor(
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
