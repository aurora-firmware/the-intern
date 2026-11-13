import { mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "../config/config_file.ts";
import { type FileStore, writeFileAtomic } from "./file_store.ts";

export const DEFAULT_SHIPPED_ROOT = fileURLToPath(new URL("../shipped", import.meta.url));

const FOLDER_MODE = 0o700;
const MANIFEST_VERSION = 1;
const SKILLS_PREFIX = "skills/";

export type ShippedManifest = { version: 1; files: Record<string, string> };

export type ShippedFileState = { edited: boolean; missing: boolean };

export class InternalFolderError extends Error {
    readonly path: string;
    readonly reason: string;

    constructor(path: string, reason: string) {
        super(`${path}: ${reason}`);
        this.name = "InternalFolderError";
        this.path = path;
        this.reason = reason;
    }
}

export const instructionsFolderPath = (dataDir: string): string => join(dataDir, "instructions");
export const commonPromptPath = (dataDir: string): string => join(instructionsFolderPath(dataDir), "common.md");
export const roleInstructionPath = (dataDir: string, role: string): string =>
    join(instructionsFolderPath(dataDir), "roles", `${role}.md`);
export const skillsFolderPath = (dataDir: string): string => join(dataDir, "skills");
export const manifestPath = (dataDir: string): string => join(dataDir, "shipped-files.json");

type ShippedFile = { relativePath: string; bytes: Buffer; hash: string };

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

// Every failure of the start rule names the path it was working on.
async function atPath<T>(path: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof InternalFolderError) throw error;
        throw new InternalFolderError(path, (error as Error).message);
    }
}

async function readBytesOrUndefined(path: string): Promise<Buffer | undefined> {
    try {
        return await readFile(path);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw new InternalFolderError(path, (error as Error).message);
    }
}

async function hashOf(path: string): Promise<string | undefined> {
    const bytes = await readBytesOrUndefined(path);
    return bytes === undefined ? undefined : fingerprintOf(bytes);
}

function isHashRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((hash) => typeof hash === "string")
    );
}

export async function readManifest(dataDir: string): Promise<ShippedManifest> {
    const path = manifestPath(dataDir);
    const bytes = await readBytesOrUndefined(path);
    if (bytes === undefined) return { version: MANIFEST_VERSION, files: {} };
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new InternalFolderError(path, "the manifest isn't valid JSON; delete it to record the files again");
    }
    const manifest = parsed as { version?: unknown; files?: unknown };
    if (manifest?.version !== MANIFEST_VERSION || !isHashRecord(manifest.files)) {
        throw new InternalFolderError(path, `the manifest isn't version ${MANIFEST_VERSION} with a files table`);
    }
    return { version: MANIFEST_VERSION, files: manifest.files };
}

async function listShippedFiles(shippedRoot: string): Promise<ShippedFile[]> {
    const entries = await atPath(shippedRoot, () => readdir(shippedRoot, { recursive: true, withFileTypes: true }));
    const files = await Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
                const path = join(entry.parentPath, entry.name);
                const bytes = await atPath(path, () => readFile(path));
                const relativePath = relative(shippedRoot, path).split(sep).join("/");
                return { relativePath, bytes, hash: fingerprintOf(bytes) };
            }),
    );
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function shippedFileStates(options: {
    dataDir: string;
    shippedRoot: string;
}): Promise<Record<string, ShippedFileState>> {
    const manifest = await readManifest(options.dataDir);
    const states: Record<string, ShippedFileState> = {};
    for (const file of await listShippedFiles(options.shippedRoot)) {
        const current = await hashOf(join(options.dataDir, file.relativePath));
        const recorded = manifest.files[file.relativePath];
        states[file.relativePath] = {
            edited: recorded !== undefined && current !== recorded,
            missing: current === undefined,
        };
    }
    return states;
}

async function makeFolder(path: string): Promise<void> {
    await atPath(path, () => mkdir(path, { recursive: true, mode: FOLDER_MODE }));
}

async function writeCopy(dataDir: string, file: ShippedFile): Promise<void> {
    const target = join(dataDir, file.relativePath);
    await makeFolder(dirname(target));
    await atPath(target, () => writeFileAtomic(target, file.bytes));
}

// Decides what the manifest records for one shipped file, copying or replacing the file when the rule says so.
async function settleShippedFile(dataDir: string, file: ShippedFile, recorded: string | undefined): Promise<string> {
    const current = await hashOf(join(dataDir, file.relativePath));
    if (recorded === undefined) {
        if (current === undefined) await writeCopy(dataDir, file);
        return file.hash;
    }
    if (current === recorded) {
        if (file.hash !== recorded) await writeCopy(dataDir, file);
        return file.hash;
    }
    return current === file.hash ? file.hash : recorded;
}

async function removeEmptySkillFolders(dataDir: string, removed: string): Promise<void> {
    if (!removed.startsWith(SKILLS_PREFIX)) return;
    const skills = skillsFolderPath(dataDir);
    for (let folder = dirname(join(dataDir, removed)); folder !== skills; folder = dirname(folder)) {
        try {
            await rmdir(folder);
        } catch (error) {
            if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "ENOENT") return;
            throw new InternalFolderError(folder, (error as Error).message);
        }
    }
}

async function removeUnshippedFile(dataDir: string, relativePath: string, recorded: string): Promise<void> {
    const path = join(dataDir, relativePath);
    if ((await hashOf(path)) !== recorded) return;
    await atPath(path, () => rm(path));
    await removeEmptySkillFolders(dataDir, relativePath);
}

async function runStartRule(dataDir: string, shippedRoot: string): Promise<void> {
    await makeFolder(join(dataDir, "instructions", "roles"));
    await makeFolder(skillsFolderPath(dataDir));
    const manifest = await readManifest(dataDir);
    const shipped = await listShippedFiles(shippedRoot);
    const next: Record<string, string> = {};
    for (const file of shipped) {
        next[file.relativePath] = await settleShippedFile(dataDir, file, manifest.files[file.relativePath]);
    }
    for (const [relativePath, recorded] of Object.entries(manifest.files)) {
        if (!(relativePath in next)) await removeUnshippedFile(dataDir, relativePath, recorded);
    }
    const path = manifestPath(dataDir);
    const text = `${JSON.stringify({ version: MANIFEST_VERSION, files: next }, null, 2)}\n`;
    await atPath(path, () => writeFileAtomic(path, text));
}

export function prepareInternalFolder(options: {
    dataDir: string;
    shippedRoot: string;
    store: FileStore;
}): Promise<void> {
    return options.store.enqueue(() => runStartRule(options.dataDir, options.shippedRoot));
}
