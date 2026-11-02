/**
 * The online copy of the instance's database (S-004 REQ-016; ADR-001 decision 1): SQLite's backup on the daemon's own
 * connection, so the copy is consistent while work goes on.
 */
import { chmod, link, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { backup } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessHost } from "./harness_host.ts";
import { internalDatabase } from "./harness_host.ts";

const OWNER_ONLY_FILE_MODE = 0o600;
const COPY_NAME = "copy.sqlite";
// One step copies every page, so no other statement can start between the first page and the last.
const ALL_PAGES_IN_ONE_STEP = 0x7fffffff;
const DEFAULT_ATTEMPTS = 100;
const DEFAULT_RETRY_DELAY_MS = 50;

export type BackupOptions = {
    /** How often to start the copy while a transaction is open on the connection. */
    attempts?: number;
    retryDelayMs?: number;
};

/**
 * Copies the whole database to `path`, a file that doesn't exist yet in an existing folder, and returns its size. The
 * copy is never readable by the group or others, not even while it is written: it is written inside a new folder that
 * only the service account can enter (`mkdtemp` makes it `0700`) and linked to `path` once complete, which also fails
 * rather than replace a file that appeared meanwhile.
 *
 * `backup()` copies through the same connection that pi-durable's commits and the job store use. That connection runs
 * one transaction at a time and keeps it open across awaits, and SQLite refuses to copy while the connection holds an
 * open transaction, which would otherwise put uncommitted pages in the copy. So the copy starts only when no
 * transaction is open, in a single step, and starts again after a short wait when one is. Commits that arrive during
 * the step wait for it; runs go on. A transaction that opens after the check but before the step makes SQLite refuse
 * the copy, and the call fails; the team member exports again.
 */
export async function backupDatabase(
    host: HarnessHost,
    path: string,
    options: BackupOptions = {},
): Promise<{ size: number }> {
    const privateFolder = await mkdtemp(join(dirname(path), `.${basename(path)}-`));
    try {
        const staged = join(privateFolder, COPY_NAME);
        await copyWhenNoTransactionIsOpen(host, staged, options);
        await chmod(staged, OWNER_ONLY_FILE_MODE);
        await link(staged, path);
        return { size: (await stat(path)).size };
    } finally {
        await rm(privateFolder, { recursive: true, force: true });
    }
}

async function copyWhenNoTransactionIsOpen(host: HarnessHost, staged: string, options: BackupOptions): Promise<void> {
    const { attempts = DEFAULT_ATTEMPTS, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options;
    const database = internalDatabase(host);
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (!database.isTransaction) {
            await backup(database, staged, { rate: ALL_PAGES_IN_ONE_STEP });
            return;
        }
        await sleep(retryDelayMs);
    }
    throw new Error(`The database stayed in a transaction for ${attempts} attempts, so it was not copied`);
}
