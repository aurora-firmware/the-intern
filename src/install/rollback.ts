/**
 * `bob rollback` (S-010 REQ-009): the refusals, the warning, the question and the steps that return the service to the
 * previous version with the database, configuration file and internal folder as the upgrade found them. Like the
 * upgrade, it takes `install.lock`, finishes any operation a cut-off command left, and acts on the directories
 * `service.json` holds. Notices and questions go to standard error. It imports only the installation modules and the
 * daemon's lock and report files (ADR-005 decision 2).
 */
import { writeError } from "../cli/output.ts";
import { acquireOwnership, type OwnershipHandle } from "../daemon/ownership.ts";
import { removeStartupReport } from "../daemon/startup_report.ts";
import { confirmation, decideRollback, nextStep, parseVersion, ROLLBACK_STEPS } from "./install_model.ts";
import {
    type OperationJournal,
    type Resumers,
    removeJournal,
    type StepIo,
    stepDone,
    writeJournal,
} from "./operation_journal.ts";
import { readLink, removeVersion, switchLink } from "./program_layout.ts";
import type { ServiceCommandContext } from "./service_commands.ts";
import { withInstallLock } from "./service_commands.ts";
import { hold, readServiceRecord, ServiceRefusedError, unhold } from "./service_manager.ts";
import {
    copyFor,
    INTERNAL_PARTS,
    importCopy,
    readCopyInfo,
    restoreConfig,
    restoreInternal,
    setAside,
} from "./state_copy.ts";
import { type Ask, type Running, runningFor } from "./upgrade_steps.ts";

export type RollbackInput = {
    context: ServiceCommandContext;
    yes: boolean;
    ask?: Ask;
    now?: () => Date;
    stepIo?: StepIo;
};

type ResumeOptions = { now?: () => Date; stepIo?: StepIo; ask?: Ask };

const STEP_NOTICES: Record<string, string> = {
    held: "Holding the service so it stays stopped.",
    stopped: "Stopping the service.",
    owned: "Taking ownership of the state directory.",
    "set-aside": "Setting the database aside.",
    switched: "Switching to the previous version.",
    imported: "Restoring the database from the copy.",
    restored: "Putting back the configuration file and the internal folder.",
    released: "Starting the service.",
    ready: "Waiting for the previous version to be ready.",
};

type Owner = { handle: OwnershipHandle | null };

async function releaseVersion(run: Running, owner: Owner): Promise<void> {
    await removeStartupReport(run.dirs.stateDir);
    await owner.handle?.release();
    await unhold(run.context.layout);
    await run.context.managerFor(run.record.platform).start(run.record);
}

async function restoredStep(run: Running): Promise<void> {
    const { dirs, journal } = run;
    const copyName = journal.copyName as string;
    await restoreConfig(dirs, copyName, `${copyName}-config-of-${journal.to}`);
    for (const part of INTERNAL_PARTS) await restoreInternal(dirs, copyName, part);
}

/** Runs one step's work. In the journal `from` is the version rolled back to and `to` the version left. */
async function performStep(step: string, run: Running, owner: Owner): Promise<void> {
    const { context, record, dirs, journal } = run;
    switch (step) {
        case "held":
            await hold(context.layout);
            return;
        case "stopped":
            await context.managerFor(record.platform).stop(record);
            return;
        case "owned":
            owner.handle = await acquireOwnership(dirs.stateDir);
            return;
        case "set-aside":
            journal.setAsideName = await setAside(dirs, journal.to, "rollback", run.now());
            return;
        case "switched":
            await switchLink(context.layout, "current", journal.from);
            return;
        case "imported":
            await importCopy(context.layout, journal.from, dirs, journal.copyName as string, owner.handle?.token ?? "");
            return;
        case "restored":
            await restoredStep(run);
            return;
        case "released":
            await releaseVersion(run, owner);
    }
}

async function requireReady(run: Running): Promise<void> {
    let reason: string | undefined;
    try {
        const result = await run.context.waitForReady(run.record);
        if (!result.ready) reason = result.report?.reason ?? "it wrote no startup report";
    } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
    }
    if (reason !== undefined) {
        throw new ServiceRefusedError(
            `Version ${run.journal.from} isn't ready after the rollback: ${reason}. The rollback is left unfinished.`,
        );
    }
}

/** Runs the steps after `journal.lastStep`, then removes the version it left, the `previous` link and the journal. */
async function runRollbackSteps(run: Running): Promise<void> {
    const { context, dirs, journal } = run;
    const first = nextStep(ROLLBACK_STEPS, journal.lastStep);
    const firstIndex = first === null ? ROLLBACK_STEPS.length : ROLLBACK_STEPS.indexOf(first as never);
    const owner: Owner = { handle: null };
    // A resume after `owned` takes the lock again: the process that took it is gone.
    if (firstIndex > ROLLBACK_STEPS.indexOf("owned") && firstIndex <= ROLLBACK_STEPS.indexOf("released")) {
        owner.handle = await acquireOwnership(dirs.stateDir);
    }
    for (const step of ROLLBACK_STEPS.slice(firstIndex)) {
        writeError(context.io, STEP_NOTICES[step]);
        if (step === "ready") await requireReady(run);
        else await performStep(step, run, owner);
        await stepDone(context.layout, journal, step, run.stepIo);
    }
    await removeVersion(context.layout, journal.to);
    await switchLink(context.layout, "previous", null);
    await removeJournal(context.layout);
}

/** Continues a cut-off rollback from the step after `journal.lastStep`. */
export async function resumeRollback(
    context: ServiceCommandContext,
    journal: OperationJournal,
    options: ResumeOptions = {},
): Promise<void> {
    const record = await readServiceRecord(context.layout);
    if (record === null) {
        throw new ServiceRefusedError(`Can't finish the cut-off ${journal.operation}: the service is not registered.`);
    }
    await runRollbackSteps(runningFor(context, record, journal, options));
}

function warningFor(previous: string, copyTime: string): string {
    return [
        `Rolling back to version ${previous}, as the database, configuration file and internal folder were at the upgrade (${copyTime}).`,
        "Everything done since then will be lost: the jobs and conversations,",
        "and the changes to the configuration, roles, instructions and skills, including mail accounts added since, which won't be set up any more.",
        "Work in progress at the upgrade may run again.",
        "Mail received since may be taken in again, and mail sent since may be sent again.",
        "The secrets store is left as it is.",
    ].join("\n");
}

/** The rollback proper, after any cut-off operation was finished. */
async function decideAndRun(input: RollbackInput): Promise<number> {
    const { context } = input;
    const { io, layout } = context;
    const record = await readServiceRecord(layout);
    if (record === null) {
        writeError(io, "Can't roll back: the service is not registered; run `bob service install` first.");
        return 1;
    }
    const previous = await readLink(layout, "previous");
    const current = await readLink(layout, "current");
    const journal: OperationJournal = {
        format: 1,
        operation: "rollback",
        from: previous ?? "",
        to: current ?? "",
        copyName: null,
        setAsideName: null,
        currentBefore: current,
        previousBefore: previous,
        lastStep: null,
    };
    const run = runningFor(context, record, journal, { now: input.now, stepIo: input.stepIo, ask: input.ask });
    const copyName = previous === null || current === null ? undefined : await copyFor(run.dirs, previous, current);
    const info = copyName === undefined ? undefined : await readCopyInfo(run.dirs, copyName);
    const decision = decideRollback({
        previousVersion: previous === null ? undefined : parseVersion(previous),
        currentVersion: parseVersion(current ?? "") ?? { major: 0, minor: 0, patch: 0, preRelease: [] },
        copy: info,
        isStdinTerminal: io.isStdinTerminal,
        yes: input.yes,
    });
    if (decision.kind === "refuse") {
        writeError(io, `Can't roll back: ${decision.reason}.`);
        return 1;
    }
    writeError(io, warningFor(journal.from, (info as { time: string }).time));
    if (confirmation({ yes: input.yes, isStdinTerminal: io.isStdinTerminal }) === "ask") {
        if (!(await run.ask(`Stop the service and roll back to ${journal.from}?`, false))) {
            writeError(io, "Rollback declined; nothing was changed.");
            return 1;
        }
    }
    journal.copyName = copyName as string;
    await writeJournal(layout, journal);
    await runRollbackSteps(run);
    return 0;
}

/**
 * Runs `bob rollback`: 0 when the service is back on the previous version and ready, 1 with the reason on standard
 * error for a refusal, a declined question or any failure on the way. A cut-off rollback is finished and ends the command.
 */
export async function runRollback(input: RollbackInput): Promise<number> {
    const { context } = input;
    let isFinished = false;
    const resumers: Resumers = {
        ...context.resumers,
        rollback: async (journal) => {
            await context.resumers.rollback(journal);
            isFinished = true;
        },
    };
    try {
        return await withInstallLock(context.layout, "rollback", resumers, async () => {
            if (isFinished) return 0;
            return decideAndRun(input);
        });
    } catch (error) {
        writeError(context.io, error instanceof Error ? error.message : String(error));
        return 1;
    }
}
