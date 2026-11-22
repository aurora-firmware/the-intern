/**
 * The operation journal (ADR-013 decisions 4 and 8): `operation.json` records which operation is under way and the last
 * step it finished, so an installation command that finds one can finish the cut-off operation. It also holds the
 * test hook that stops a process after a named step. It imports only Node modules and the installation model.
 */
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProgramLayout } from "./program_layout.ts";

const JOURNAL_FORMAT = 1;
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const STOP_AFTER_VARIABLE = "BOB_INSTALL_TEST_STOP_AFTER";
const RESUME_SIGNAL = "SIGUSR2";
/** Keeps the event loop alive while the test hook waits for its signal. */
const KEEP_ALIVE_MS = 2 ** 30;

export type OperationJournal = {
    format: 1;
    operation: "upgrade" | "switch-back" | "fresh-start" | "rollback";
    from: string;
    to: string;
    copyName: string | null;
    setAsideName: string | null;
    currentBefore: string | null;
    previousBefore: string | null;
    lastStep: string | null;
};

/** What the test hook touches, so a test can replace the process. */
export type StepIo = {
    env: NodeJS.ProcessEnv;
    writeError: (text: string) => void;
    waitForResume: () => Promise<void>;
};

export type Resumers = Record<OperationJournal["operation"], (journal: OperationJournal) => Promise<void>>;

/** The journal file is unusable. The message names the file and says why. */
export class OperationJournalError extends Error {
    path: string;

    constructor(path: string, reason: string) {
        super(`Operation journal ${path}: ${reason}`);
        this.name = "OperationJournalError";
        this.path = path;
    }
}

/** Writes the journal beside `operation.json` and renames it over, so a reader sees the old or the new one. */
export async function writeJournal(layout: ProgramLayout, journal: OperationJournal): Promise<void> {
    await mkdir(dirname(layout.journal), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const temporary = `${layout.journal}.${process.pid}.tmp`;
    const file = await open(temporary, "w", OWNER_ONLY_FILE_MODE);
    try {
        await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
        await file.chmod(OWNER_ONLY_FILE_MODE);
        await file.sync();
    } finally {
        await file.close();
    }
    try {
        await rename(temporary, layout.journal);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

/** The journal, or null when there is none. Refuses a newer `format` or a file that is not a journal. */
export async function readJournal(layout: ProgramLayout): Promise<OperationJournal | null> {
    let text: string;
    try {
        text = await readFile(layout.journal, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new OperationJournalError(layout.journal, "the file is not valid JSON");
    }
    const format = (parsed as { format?: unknown } | null)?.format;
    if (typeof format !== "number") throw new OperationJournalError(layout.journal, "the file has no format number");
    if (format > JOURNAL_FORMAT) {
        throw new OperationJournalError(
            layout.journal,
            `its format is ${format}, newer than ${JOURNAL_FORMAT}; use the newer version of bob that wrote it`,
        );
    }
    return parsed as OperationJournal;
}

export async function removeJournal(layout: ProgramLayout): Promise<void> {
    await rm(layout.journal, { force: true });
}

function waitForResumeSignal(): Promise<void> {
    return new Promise((resolve) => {
        const keepAlive = setTimeout(() => {}, KEEP_ALIVE_MS);
        process.once(RESUME_SIGNAL, () => {
            clearTimeout(keepAlive);
            resolve();
        });
    });
}

const PROCESS_IO: StepIo = {
    env: process.env,
    writeError: (text) => {
        process.stderr.write(text);
    },
    waitForResume: waitForResumeSignal,
};

/**
 * Records the finished step in the journal. When the test hook variable names the step, it then reports
 * `stopped after <step>` on standard error and returns only after SIGUSR2.
 */
export async function stepDone(
    layout: ProgramLayout,
    journal: OperationJournal,
    step: string,
    io: StepIo = PROCESS_IO,
): Promise<void> {
    journal.lastStep = step;
    await writeJournal(layout, journal);
    if (io.env[STOP_AFTER_VARIABLE] !== step) return;
    const resumed = io.waitForResume();
    io.writeError(`stopped after ${step}\n`);
    await resumed;
}

/** Hands a journal found on disk to the resumer of its operation; does nothing when there is none. */
export async function finishCutOffOperation(layout: ProgramLayout, resumers: Resumers): Promise<void> {
    const journal = await readJournal(layout);
    if (journal === null) return;
    await resumers[journal.operation](journal);
}
