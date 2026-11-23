/**
 * What `bob upgrade` does when the new version isn't ready (S-010 REQ-007, REQ-008): the switch-back, REQ-008's
 * question and fresh start, and the resumers of those operations. It imports only the installation modules.
 */

import { join } from "node:path";
import { writeError } from "../cli/output.ts";
import { type OperationJournal, type StepIo, writeJournal } from "./operation_journal.ts";
import type { ServiceCommandContext } from "./service_commands.ts";
import { readServiceRecord, ServiceRefusedError } from "./service_manager.ts";
import { upgradesDir } from "./state_copy.ts";
import { type Ask, type NotReady, type Running, runningFor, runSteps } from "./upgrade_steps.ts";

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
export async function runUpgradeSteps(run: Running): Promise<void> {
    const notReady = await runSteps(run);
    if (notReady !== null) await handleNotReady(run, notReady);
}

export type ResumeOptions = { now?: () => Date; stepIo?: StepIo; ask?: Ask };

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
