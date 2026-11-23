/**
 * `bob upgrade` (S-010 REQ-006): the refusals, the confirmation and the steps that move the service to a newer version.
 * The command takes `install.lock`, finishes any operation a cut-off command left, then acts on the directories
 * `service.json` holds, never its own environment's (REQ-004). Notices and questions go to standard error. It imports
 * only the installation modules and the daemon's lock and report files (ADR-005 decision 2).
 */
import { existsSync } from "node:fs";
import { writeError } from "../cli/output.ts";
import { readOwnerLock } from "../daemon/ownership.ts";
import { readStartupReport } from "../daemon/startup_report.ts";
import { confirmation, decideUpgrade, parseVersion, type UpgradeFacts, type Version } from "./install_model.ts";
import { type OperationJournal, type Resumers, type StepIo, writeJournal } from "./operation_journal.ts";
import { readLink, removeVersion } from "./program_layout.ts";
import { fetchBundle, latestVersion, releaseSource } from "./release_source.ts";
import type { ServiceCommandContext } from "./service_commands.ts";
import { withInstallLock } from "./service_commands.ts";
import { readServiceRecord, type ServiceRecord } from "./service_manager.ts";
import { runUpgradeSteps } from "./upgrade_recovery.ts";
import { type Ask, askYesNo, runningFor } from "./upgrade_steps.ts";

export { resumeFreshStart, resumeSwitchBack, resumeUpgrade } from "./upgrade_recovery.ts";
export { type Ask, askYesNo } from "./upgrade_steps.ts";

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
    ask?: Ask;
    now?: () => Date;
    stepIo?: StepIo;
};

const NO_VERSION: Version = { major: 0, minor: 0, patch: 0, preRelease: [] };

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
