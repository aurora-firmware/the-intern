/**
 * The upgrades folder (ADR-013 decision 7): the pre-upgrade copy taken with the service stopped, and the databases set
 * aside by an upgrade or a rollback. The commands call these while holding the owner lock; this module takes no lock.
 * It imports only Node modules and the instance directories (ADR-005 decision 2).
 */
import { chmod, cp, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { InstanceDirs } from "../daemon/state_layout.ts";

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const SUPPORTED_FORMAT = 1;
const COPY_INFO_FILE = "copy.json";
const DATABASE_PART = "database.sqlite";
const CONFIG_PART = "config.toml";
const INTERNAL_PART = "internal";
const INTERNAL_ENTRIES = ["instructions", "skills", "shipped-files.json"];
const PARTIAL_PREFIX = ".partial-";
const DATABASE_SIBLING_SUFFIXES = ["-wal", "-shm"];
// One step copies every page, so the copy is one consistent snapshot.
const ALL_PAGES_IN_ONE_STEP = 0x7fffffff;

export type SetAsideReason = "unreadable" | "failed-upgrade" | "rollback";

export type CopyInfo = {
    format: 1;
    from: string;
    to: string;
    time: string;
    parts: string[];
    kept: boolean;
};

/** A `copy.json` that can't be read by this release, or the instance has nothing to copy. The message says what. */
export class StateCopyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StateCopyError";
    }
}

export function upgradesDir(stateDir: string): string {
    return join(stateDir, "upgrades");
}

async function ensureUpgradesDir(stateDir: string): Promise<string> {
    const path = upgradesDir(stateDir);
    try {
        await mkdir(path, { mode: OWNER_ONLY_DIR_MODE });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // mkdir's mode is masked by the umask, so the mode is set explicitly as well.
    await chmod(path, OWNER_ONLY_DIR_MODE);
    return path;
}

function folderTime(now: Date): string {
    return now.toISOString().replace(/[:.]/g, "-");
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function restrictTree(root: string): Promise<void> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        await chmod(path, entry.isDirectory() ? OWNER_ONLY_DIR_MODE : OWNER_ONLY_FILE_MODE);
    }
}

async function writeOwnerOnly(path: string, text: string): Promise<void> {
    const file = await open(path, "w", OWNER_ONLY_FILE_MODE);
    try {
        await file.writeFile(text);
        await file.chmod(OWNER_ONLY_FILE_MODE);
    } finally {
        await file.close();
    }
}

async function copyDatabase(databaseFile: string, target: string): Promise<void> {
    if (!(await exists(databaseFile))) {
        throw new StateCopyError(`There is no database to copy: ${databaseFile} does not exist.`);
    }
    const source = new DatabaseSync(databaseFile);
    try {
        await backup(source, target, { rate: ALL_PAGES_IN_ONE_STEP });
    } finally {
        source.close();
    }
}

async function copyInternalFolder(dataDir: string, target: string): Promise<void> {
    await mkdir(target);
    for (const entry of INTERNAL_ENTRIES) {
        const source = join(dataDir, entry);
        if (await exists(source)) await cp(source, join(target, entry), { recursive: true });
    }
}

/**
 * Copies the stopped instance's database, config file and internal folder into `<time>-<from>-to-<to>/` of the
 * upgrades folder and returns the folder's name. Never the secrets store. The copy is written into a `.partial-`
 * folder and renamed when complete, so a copy that is cut off leaves only the partial folder.
 */
export async function takeCopy(dirs: InstanceDirs, from: string, to: string, now: Date): Promise<string> {
    const upgrades = await ensureUpgradesDir(dirs.stateDir);
    const partial = await mkdtemp(join(upgrades, PARTIAL_PREFIX));
    const parts = [DATABASE_PART];
    await copyDatabase(dirs.databaseFile, join(partial, DATABASE_PART));
    if (await exists(dirs.configFile)) {
        await cp(dirs.configFile, join(partial, CONFIG_PART));
        parts.push(CONFIG_PART);
    }
    await copyInternalFolder(dirs.dataDir, join(partial, INTERNAL_PART));
    parts.push(INTERNAL_PART);
    const info: CopyInfo = { format: SUPPORTED_FORMAT, from, to, time: now.toISOString(), parts, kept: false };
    await writeOwnerOnly(join(partial, COPY_INFO_FILE), JSON.stringify(info));
    await restrictTree(partial);
    const name = `${folderTime(now)}-${from}-to-${to}`;
    await rename(partial, join(upgrades, name));
    return name;
}

/**
 * Moves the database file with its `-wal` and `-shm` files by rename into `<time>-<version>-<reason>/` of the
 * upgrades folder and returns the folder's name. The state directory holds no database file afterwards.
 */
export async function setAside(
    dirs: InstanceDirs,
    version: string,
    reason: SetAsideReason,
    now: Date,
): Promise<string> {
    const upgrades = await ensureUpgradesDir(dirs.stateDir);
    const name = `${folderTime(now)}-${version}-${reason}`;
    const folder = join(upgrades, name);
    await mkdir(folder, { mode: OWNER_ONLY_DIR_MODE });
    await chmod(folder, OWNER_ONLY_DIR_MODE);
    const files = [dirs.databaseFile, ...DATABASE_SIBLING_SUFFIXES.map((suffix) => `${dirs.databaseFile}${suffix}`)];
    for (const file of files) {
        if (!(await exists(file))) continue;
        const target = join(folder, file.slice(dirs.stateDir.length + 1));
        await rename(file, target);
        await chmod(target, OWNER_ONLY_FILE_MODE);
    }
    return name;
}

/** The `copy.json` of a copy. Refuses a file of a newer format, or one that is not a copy's info, naming the file. */
export async function readCopyInfo(dirs: InstanceDirs, copyName: string): Promise<CopyInfo> {
    const path = join(upgradesDir(dirs.stateDir), copyName, COPY_INFO_FILE);
    let parsed: Partial<CopyInfo> | null;
    try {
        parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CopyInfo> | null;
    } catch (error) {
        throw new StateCopyError(`${path} can't be read as JSON: ${(error as Error).message}`);
    }
    if (typeof parsed?.format !== "number") throw new StateCopyError(`${path} has no format number.`);
    if (parsed.format > SUPPORTED_FORMAT) {
        throw new StateCopyError(
            `${path} is of format ${parsed.format}, newer than the format ${SUPPORTED_FORMAT} this release reads.`,
        );
    }
    return parsed as CopyInfo;
}

/** The names of the copies, newest first. A set-aside folder holds no `copy.json` and is not one. */
async function copyNames(dirs: InstanceDirs): Promise<string[]> {
    const upgrades = upgradesDir(dirs.stateDir);
    let entries: string[];
    try {
        entries = await readdir(upgrades);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const names: string[] = [];
    for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        if (await exists(join(upgrades, entry, COPY_INFO_FILE))) names.push(entry);
    }
    return names.sort().reverse();
}

/** The newest copy's name and `copy.json`, or undefined when there is no copy. */
export async function latestCopy(dirs: InstanceDirs): Promise<{ name: string; info: CopyInfo } | undefined> {
    const [name] = await copyNames(dirs);
    return name === undefined ? undefined : { name, info: await readCopyInfo(dirs, name) };
}

/** The name of the newest copy taken for the upgrade from `from` to `to`, or undefined. */
export async function copyFor(dirs: InstanceDirs, from: string, to: string): Promise<string | undefined> {
    for (const name of await copyNames(dirs)) {
        const info = await readCopyInfo(dirs, name);
        if (info.from === from && info.to === to) return name;
    }
    return undefined;
}

/** Records that the copy is kept: pruning never removes it. */
export async function markKept(dirs: InstanceDirs, copyName: string): Promise<void> {
    const info = await readCopyInfo(dirs, copyName);
    const folder = join(upgradesDir(dirs.stateDir), copyName);
    const beside = join(folder, `.${COPY_INFO_FILE}.tmp`);
    await writeOwnerOnly(beside, JSON.stringify({ ...info, kept: true }));
    await rename(beside, join(folder, COPY_INFO_FILE));
}

/** Removes the copies older than `keepName` that are not kept. Never a newer copy, and never a set-aside database. */
export async function pruneCopies(dirs: InstanceDirs, keepName: string): Promise<void> {
    for (const name of await copyNames(dirs)) {
        if (name >= keepName) continue;
        if ((await readCopyInfo(dirs, name)).kept) continue;
        await rm(join(upgradesDir(dirs.stateDir), name), { recursive: true, force: true });
    }
}
