/**
 * The files operations (S-008 REQ-010): `files.read` and `files.write` reach the instruction files, the skill folders the
 * catalog found and the context files of a workspace and its parent folders, and nothing else. The path is normalised
 * with `path.resolve`, which follows no link, and checked by the file it names, as written or by its real path. The
 * operations then follow the links wherever they lead: the service account's permissions decide, and a refusal of the
 * system is reported with its reason (ADR-002 decision 4). Neither operation creates or deletes a file.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getSystemErrorMessage } from "node:util";
import type { ServiceContext } from "../daemon/daemon.ts";
import { type FileChangeKind, FileRefusedError } from "../skills/file_store.ts";
import { instructionsFolderPath } from "../skills/internal_folder.ts";
import { readCatalog } from "../skills/skill_discovery.ts";
import type { SkillsComponent } from "../skills/skills_component.ts";
import { skillsSection } from "../skills/skills_section.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

// Every name pi agent's `loadProjectContextFiles` tries in a folder, whether or not it reads that file in place of another.
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

const REFUSED_BY_SYSTEM = new Set(["EACCES", "EPERM", "EROFS", "ELOOP"]);

type ReadInput = { path: string };
type WriteInput = { path: string; text: string; version: string };

function parseRead(raw: unknown): ReadInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { path } = raw as Record<string, unknown>;
    if (typeof path !== "string" || path === "") throw new Error("path must be a non-empty string");
    return { path };
}

function parseWrite(raw: unknown): WriteInput {
    const { path } = parseRead(raw);
    const { text, version } = raw as Record<string, unknown>;
    if (typeof text !== "string") throw new Error("text must be a string");
    if (typeof version !== "string" || version === "") throw new Error("version must be a non-empty string");
    return { path, text, version };
}

const isMissing = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
};

/** The real path of the nearest existing folder on the path, with the rest of the path added. */
async function resolvePath(path: string): Promise<string> {
    const rest: string[] = [];
    let current = resolve(path);
    for (;;) {
        try {
            return join(await realpath(current), ...rest);
        } catch (error) {
            if (!isMissing(error) || dirname(current) === current) throw error;
            rest.unshift(basename(current));
            current = dirname(current);
        }
    }
}

/** The real path of a folder that may not exist, or undefined when no part of it does. */
async function realFolder(path: string): Promise<string | undefined> {
    try {
        return await resolvePath(path);
    } catch {
        return undefined;
    }
}

const isBelow = (path: string, folder: string): boolean => {
    const inside = relative(folder, path);
    return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

type AllowedSet = { skillFolders: string[]; instructions: string; workspaceFiles: string[] };

/** The allowed files as written (each workspace and skill folder by the path it is registered or found at) and as real paths. */
type AllowedFiles = { written: AllowedSet; real: AllowedSet };

const kindOf = (path: string, allowed: AllowedSet): FileChangeKind | undefined => {
    if (allowed.workspaceFiles.includes(path)) return "workspace";
    if (isBelow(path, allowed.instructions)) {
        const inside = relative(allowed.instructions, path);
        if (inside === "common.md") return "common";
        return inside.startsWith(`roles${sep}`) ? "role" : "instructions";
    }
    return allowed.skillFolders.some((folder) => isBelow(path, folder)) ? "skill" : undefined;
};

/** The folder and each parent folder up to the root. */
function folderAndParents(folder: string): string[] {
    const folders = [folder];
    for (let parent = dirname(folder); parent !== folders.at(-1); parent = dirname(parent)) folders.push(parent);
    return folders;
}

export function fileOperations(component: SkillsComponent) {
    /** Every file the operations may reach, as written and as real paths, read fresh at each call. */
    const allowedFiles = async (ctx: ServiceContext): Promise<AllowedFiles> => {
        const workspaces = component.agentsRuntime().workspaces.list();
        const dataDir = component.dataDir();
        const catalogs = await Promise.all(
            [undefined, ...workspaces.map(({ path }) => path)].map((workspace) =>
                readCatalog({
                    dataDir,
                    shippedRoot: component.shippedRoot,
                    searchPaths: ctx.config.current(skillsSection).paths,
                    ...(workspace !== undefined && { workspace }),
                }),
            ),
        );
        const found = [
            ...new Set(
                catalogs.flatMap((catalog) => [
                    ...catalog.skills.flatMap((skill) => [skill.folder, ...skill.shadowed.map(({ path }) => path)]),
                    ...catalog.leftOut.map(({ path }) => dirname(path)),
                ]),
            ),
        ].map((folder) => resolve(folder));
        const contextFiles = [
            ...new Set(
                workspaces.flatMap(({ path }) =>
                    folderAndParents(resolve(path)).flatMap((folder) =>
                        CONTEXT_FILES.map((name) => join(folder, name)),
                    ),
                ),
            ),
        ];
        const instructions = instructionsFolderPath(dataDir);
        const realOf = async (paths: string[]) =>
            (await Promise.all(paths.map(realFolder))).filter((path) => path !== undefined);
        return {
            written: { skillFolders: found, instructions, workspaceFiles: contextFiles },
            real: {
                skillFolders: await realOf(found),
                instructions: (await realFolder(instructions)) ?? instructions,
                workspaceFiles: await realOf(contextFiles),
            },
        };
    };

    /** The normalised path and its kind; a path outside the allowed files, as written or by its real path, is refused. */
    const locate = async (ctx: ServiceContext, path: string): Promise<{ file: string; kind: FileChangeKind }> => {
        if (!isAbsolute(path)) throw new ServiceError("invalid_input", `${path} is not an absolute path`);
        const file = resolve(path);
        const allowed = await allowedFiles(ctx);
        const kind = kindOf(file, allowed.written) ?? kindOf((await realFolder(file)) ?? file, allowed.real);
        if (kind === undefined) {
            throw new ServiceError(
                "invalid_input",
                `${path} is not an instruction file, a skill file or a context file of a workspace`,
            );
        }
        return { file, kind };
    };

    const refusalOf = (error: unknown, path: string): unknown => {
        if (error instanceof FileRefusedError) {
            const code = { not_found: "not_found", invalid: "invalid_input", conflict: "conflict" } as const;
            return new ServiceError(code[error.kind], error.message);
        }
        const { code, errno } = error as NodeJS.ErrnoException;
        if (isMissing(error)) return new ServiceError("not_found", `${path}: the file doesn't exist`);
        if (code !== undefined && REFUSED_BY_SYSTEM.has(code) && errno !== undefined) {
            return new ServiceError("invalid_input", `${path}: ${getSystemErrorMessage(errno)}`);
        }
        return error;
    };

    const readOperation = defineOperation<ServiceContext, ReadInput, { text: string; version: string }>({
        name: "files.read",
        kind: "read",
        parse: parseRead,
        async run(ctx, { path }) {
            const { file } = await locate(ctx, path);
            try {
                return await component.fileStore.read(file);
            } catch (error) {
                throw refusalOf(error, file);
            }
        },
    });

    const writeOperation = defineOperation<ServiceContext, WriteInput, { version: string }>({
        name: "files.write",
        kind: "control",
        parse: parseWrite,
        async run(ctx, { path, text, version }) {
            const { file, kind } = await locate(ctx, path);
            try {
                return { version: await component.fileStore.write(file, text, { version, announce: kind }) };
            } catch (error) {
                throw refusalOf(error, file);
            }
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [readOperation, writeOperation];
    return operations;
}
