/**
 * The import step (S-004 REQ-017; ADR-001 decision 1): places an exported database file as an instance's database.
 * It runs as its own process while the instance's daemon is stopped, under the instance's single-owner lock, and it
 * never converts the file. It lives under `src/host/` because it reads pi-durable's schema version; the job store
 * itself never reads pi-durable's tables.
 */
import { chmod, copyFile, constants as fsConstants, link, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { acquireOwnership, OwnershipRefusedError } from "../daemon/ownership.ts";
import { resolveInstanceDirs } from "../daemon/state_layout.ts";
import { JOB_SCHEMA_VERSION, readJobSchemaVersion } from "../jobs/job_store.ts";
import { openHostDatabase } from "./harness_host.ts";

const OWNER_ONLY_FILE_MODE = 0o600;
const STAGING_PREFIX = ".import-";
const STAGED_NAME = "import.sqlite";
const SIBLING_SUFFIXES = ["-wal", "-shm"];

/** The import was refused; the message names the reason and nothing was changed. */
export class ImportRefusedError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ImportRefusedError";
    }
}

export type ImportOptions = {
    /** Test-only: runs once the lock is held and the checks of the state directory have passed. */
    whileOwned?: () => Promise<void> | void;
};

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function takeOwnership(stateDir: string) {
    try {
        return await acquireOwnership(stateDir);
    } catch (error) {
        if (error instanceof OwnershipRefusedError) {
            throw new ImportRefusedError(
                `Refused: a running daemon (pid ${error.ownerPid}) owns ${stateDir}. Stop it, then import again.`,
                { cause: error },
            );
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ImportRefusedError(`Refused: the state directory ${stateDir} does not exist.`, { cause: error });
        }
        throw error;
    }
}

async function refuseLeftovers(databaseFile: string): Promise<void> {
    if (await exists(databaseFile)) {
        throw new ImportRefusedError(`Refused: the state directory already holds a database file, ${databaseFile}.`);
    }
    for (const suffix of SIBLING_SUFFIXES) {
        if (await exists(`${databaseFile}${suffix}`)) {
            throw new ImportRefusedError(
                `Refused: the state directory holds ${databaseFile}${suffix}, left by an earlier database. ` +
                    "Remove it only if that database is gone.",
            );
        }
    }
}

async function readDurableSchemaVersion(database: DatabaseSync): Promise<number> {
    const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (!table.get("durable_schema")) return 0;
    const row = database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
    return typeof row?.version === "number" ? row.version : 0;
}

/**
 * Reads both schema versions from the staged copy. A WAL-mode export (SQLite's backup keeps the WAL flag in the file
 * header) makes a read-only open create `-wal` and `-shm` files beside the file it opens, so the checks open the
 * private staged copy, never the file the team member named.
 */
async function refuseNewerSchemas(staged: string, file: string): Promise<void> {
    let jobVersion: number;
    let durableVersion: number;
    const job = await openHostDatabase(staged, { readOnly: true });
    try {
        jobVersion = await readJobSchemaVersion(job);
    } catch (error) {
        throw new ImportRefusedError(`Refused: ${file} is not a SQLite database.`, { cause: error });
    } finally {
        // A close that fails on a file that isn't a database must not hide the refusal.
        await job.close().catch(() => undefined);
    }
    const durable = new DatabaseSync(staged, { readOnly: true });
    try {
        durableVersion = await readDurableSchemaVersion(durable);
    } finally {
        durable.close();
    }
    if (jobVersion > JOB_SCHEMA_VERSION) {
        throw new ImportRefusedError(
            `Refused: the file holds job schema version ${jobVersion}, newer than version ${JOB_SCHEMA_VERSION} ` +
                "this release supports. Use a newer release.",
        );
    }
    if (durableVersion > CURRENT_SQLITE_SCHEMA_VERSION) {
        throw new ImportRefusedError(
            `Refused: the file holds pi-durable schema version ${durableVersion}, newer than version ` +
                `${CURRENT_SQLITE_SCHEMA_VERSION} this release supports. Use a newer release.`,
        );
    }
}

async function stageCopy(folder: string, file: string): Promise<string> {
    const staged = join(folder, STAGED_NAME);
    try {
        await copyFile(file, staged, fsConstants.COPYFILE_EXCL);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ImportRefusedError(`Refused: the file ${file} does not exist.`, { cause: error });
        }
        throw error;
    }
    await chmod(staged, OWNER_ONLY_FILE_MODE);
    return staged;
}

async function placeCopy(stateDir: string, databaseFile: string, file: string): Promise<void> {
    // mkdtemp makes the folder 0700, so the copy is never readable by others while it is staged and checked.
    const folder = await mkdtemp(join(stateDir, STAGING_PREFIX));
    try {
        const staged = await stageCopy(folder, file);
        await refuseNewerSchemas(staged, file);
        // link fails rather than replace a database file that appeared meanwhile.
        await link(staged, databaseFile);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}

/**
 * Places `file`, an exported database, as the database of the instance whose state directory is `stateDir`. Refuses,
 * naming the reason and changing nothing, when a daemon runs, when the state directory holds the database file or
 * its `-wal` or `-shm` file, when the file isn't a SQLite database, and when its job or pi-durable schema is newer
 * than this release's. An older job schema is migrated at the next start. The copy is owner-only from its creation.
 */
export async function importDatabase(
    input: { stateDir: string; file: string },
    options: ImportOptions = {},
): Promise<void> {
    const { stateDir } = input;
    const file = resolve(input.file);
    const { databaseFile } = resolveInstanceDirs({ flags: { stateDir }, env: {}, homeDir: stateDir });
    const ownership = await takeOwnership(stateDir);
    try {
        await refuseLeftovers(databaseFile);
        await options.whileOwned?.();
        await placeCopy(stateDir, databaseFile, file);
    } finally {
        await ownership.release();
    }
}
