/**
 * The files operations (S-008 REQ-010): `files.read` and `files.write` reach the instruction files, the skill folders the
 * catalog found and a workspace's `AGENTS.md` and `CLAUDE.md`, and nothing else. A path is resolved first, so a missing
 * file and a symbolic link both resolve before the check. Neither operation creates or deletes a file.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ServiceContext } from "../daemon/daemon.ts";
import { type FileChangeKind, FileRefusedError } from "../skills/file_store.ts";
import { instructionsFolderPath } from "../skills/internal_folder.ts";
import { readCatalog } from "../skills/skill_discovery.ts";
import type { SkillsComponent } from "../skills/skills_component.ts";
import { skillsSection } from "../skills/skills_section.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

const WORKSPACE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

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

type AllowedFiles = { skillFolders: string[]; instructions: string; workspaceFiles: string[] };

const kindOf = (path: string, allowed: AllowedFiles): FileChangeKind | undefined => {
    if (allowed.workspaceFiles.includes(path)) return "workspace";
    if (isBelow(path, allowed.instructions)) {
        const inside = relative(allowed.instructions, path);
        if (inside === "common.md") return "common";
        return inside.startsWith(`roles${sep}`) ? "role" : "instructions";
    }
    return allowed.skillFolders.some((folder) => isBelow(path, folder)) ? "skill" : undefined;
};

export function fileOperations(component: SkillsComponent) {
    /** Every file the operations may reach, as real paths, read fresh at each call. */
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
        const found = catalogs.flatMap((catalog) => [
            ...catalog.skills.flatMap((skill) => [skill.folder, ...skill.shadowed.map(({ path }) => path)]),
            ...catalog.leftOut.map(({ path }) => dirname(path)),
        ]);
        const folders = await Promise.all([...new Set(found)].map(realFolder));
        const names = await Promise.all(
            workspaces.flatMap(({ path }) =>
                WORKSPACE_FILES.map(async (name) => realFolder(join(await resolvePath(path), name))),
            ),
        );
        return {
            skillFolders: folders.filter((folder) => folder !== undefined),
            instructions: (await realFolder(instructionsFolderPath(dataDir))) ?? instructionsFolderPath(dataDir),
            workspaceFiles: names.filter((name) => name !== undefined),
        };
    };

    /** The real path of the file and its kind; a path outside the allowed files is refused. */
    const locate = async (ctx: ServiceContext, path: string): Promise<{ file: string; kind: FileChangeKind }> => {
        if (!isAbsolute(path)) throw new ServiceError("invalid_input", `${path} is not an absolute path`);
        const file = await resolvePath(path);
        const kind = kindOf(file, await allowedFiles(ctx));
        if (kind === undefined) {
            throw new ServiceError(
                "invalid_input",
                `${path} is not an instruction file, a skill file or a workspace file`,
            );
        }
        return { file, kind };
    };

    const refusalOf = (error: unknown): unknown => {
        if (!(error instanceof FileRefusedError)) return error;
        const code = { not_found: "not_found", invalid: "invalid_input", conflict: "conflict" } as const;
        return new ServiceError(code[error.kind], error.message);
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
                throw refusalOf(error);
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
                throw refusalOf(error);
            }
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [readOperation, writeOperation];
    return operations;
}
