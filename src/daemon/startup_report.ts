/**
 * The startup report (ADR-013 decision 6): `<state dir>/startup.json`, which the daemon writes as it starts each step
 * and when it fails or reports ready, and which an installation command reads to tell the failures apart. This module
 * imports only Node modules (ADR-005 decision 2).
 */
import { open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

export const STARTUP_REPORT_FILE = "startup.json";

const SUPPORTED_FORMAT = 1;
const OWNER_ONLY_FILE_MODE = 0o600;

export type StartupReport = {
    format: 1;
    version: string;
    pid: number;
    serviceLabel: string | null;
    furthestStep: number;
    failedStep: number | null;
    failedStepName: string | null;
    reason: string | null;
    unreadableDatabase: boolean;
    ready: boolean;
};

/** Writes the report owner-only: whole into a file beside it, then renamed over the old one. */
export async function writeStartupReport(stateDir: string, report: StartupReport): Promise<void> {
    const target = join(stateDir, STARTUP_REPORT_FILE);
    const beside = join(stateDir, `.${STARTUP_REPORT_FILE}.${process.pid}.tmp`);
    const file = await open(beside, "w", OWNER_ONLY_FILE_MODE);
    try {
        await file.writeFile(JSON.stringify(report));
        // The creation mode is masked by the umask, so the mode is set explicitly as well.
        await file.chmod(OWNER_ONLY_FILE_MODE);
    } catch (error) {
        await file.close();
        await unlink(beside).catch(() => undefined);
        throw error;
    }
    await file.close();
    try {
        await rename(beside, target);
    } catch (error) {
        await unlink(beside).catch(() => undefined);
        throw error;
    }
}

/** The report, or undefined when there is none. Refuses a file of a newer format, or one that is not a report. */
export async function readStartupReport(stateDir: string): Promise<StartupReport | undefined> {
    const path = join(stateDir, STARTUP_REPORT_FILE);
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`The startup report ${path} is not valid JSON.`, { cause: error });
    }
    const format = (parsed as { format?: unknown } | null)?.format;
    if (typeof format !== "number") throw new Error(`The startup report ${path} has no format number.`);
    if (format > SUPPORTED_FORMAT) {
        throw new Error(
            `The startup report ${path} has format ${format}, newer than format ${SUPPORTED_FORMAT} this release reads. ` +
                "Use a newer release.",
        );
    }
    return parsed as StartupReport;
}

export async function removeStartupReport(stateDir: string): Promise<void> {
    await rm(join(stateDir, STARTUP_REPORT_FILE), { force: true });
}
