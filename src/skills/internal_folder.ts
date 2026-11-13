import { mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
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

export class NotShippedError extends Error {
    readonly shippedName: string;

    constructor(name: string) {
        super(`${name}: the installed version doesn't ship it`);
        this.name = "NotShippedError";
        this.shippedName = name;
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

// A key is joined onto the data directory, so it has to stay inside it: no absolute path and no empty, "." or ".." part.
function isInsideRelativePath(key: string): boolean {
    return !key.startsWith("/") && key.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isHashRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.entries(value).every(([key, hash]) => typeof hash === "string" && isInsideRelativePath(key))
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
        throw new InternalFolderError(
            path,
            `the manifest isn't version ${MANIFEST_VERSION} with a files table of hashes keyed by paths inside the data directory`,
        );
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

async function writeManifestFiles(dataDir: string, files: Record<string, string>): Promise<void> {
    const path = manifestPath(dataDir);
    const text = `${JSON.stringify({ version: MANIFEST_VERSION, files }, null, 2)}\n`;
    await atPath(path, () => writeFileAtomic(path, text));
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
    await writeManifestFiles(dataDir, next);
}

export function prepareInternalFolder(options: {
    dataDir: string;
    shippedRoot: string;
    store: FileStore;
}): Promise<void> {
    return options.store.enqueue(() => runStartRule(options.dataDir, options.shippedRoot));
}

async function runFileRestore(dataDir: string, shippedRoot: string, relativePath: string): Promise<void> {
    const file = (await listShippedFiles(shippedRoot)).find((candidate) => candidate.relativePath === relativePath);
    if (file === undefined) throw new NotShippedError(relativePath);
    const manifest = await readManifest(dataDir);
    await writeCopy(dataDir, file);
    await writeManifestFiles(dataDir, { ...manifest.files, [relativePath]: file.hash });
}

export function restoreShippedFile(options: {
    dataDir: string;
    shippedRoot: string;
    store: FileStore;
    relativePath: string;
}): Promise<void> {
    return options.store.enqueue(() => runFileRestore(options.dataDir, options.shippedRoot, options.relativePath));
}

let skillCopyCounter = 0;

// The copy is built beside the skill, so the swap is a removal and a rename inside one folder.
async function replaceSkillFolder(dataDir: string, name: string, files: ShippedFile[]): Promise<void> {
    const skills = skillsFolderPath(dataDir);
    const target = join(skills, name);
    skillCopyCounter += 1;
    const copy = join(skills, `.${name}.${process.pid}.${skillCopyCounter}.tmp`);
    try {
        for (const file of files) {
            const path = join(copy, file.relativePath.slice(`${SKILLS_PREFIX}${name}/`.length));
            await makeFolder(dirname(path));
            await atPath(path, () => writeFileAtomic(path, file.bytes));
        }
        await atPath(target, () => rm(target, { recursive: true, force: true }));
        await atPath(target, () => rename(copy, target));
    } catch (error) {
        await rm(copy, { recursive: true, force: true });
        throw error;
    }
}

async function runSkillRestore(dataDir: string, shippedRoot: string, name: string): Promise<void> {
    const prefix = `${SKILLS_PREFIX}${name}/`;
    const files = (await listShippedFiles(shippedRoot)).filter(
        (file) => name !== "" && !name.includes("/") && name !== ".." && file.relativePath.startsWith(prefix),
    );
    if (files.length === 0) throw new NotShippedError(name);
    const manifest = await readManifest(dataDir);
    await makeFolder(skillsFolderPath(dataDir));
    await replaceSkillFolder(dataDir, name, files);
    const recorded = Object.fromEntries(Object.entries(manifest.files).filter(([key]) => !key.startsWith(prefix)));
    for (const file of files) recorded[file.relativePath] = file.hash;
    await writeManifestFiles(dataDir, recorded);
}

export function restoreShippedSkill(options: {
    dataDir: string;
    shippedRoot: string;
    store: FileStore;
    name: string;
}): Promise<void> {
    return options.store.enqueue(() => runSkillRestore(options.dataDir, options.shippedRoot, options.name));
}
