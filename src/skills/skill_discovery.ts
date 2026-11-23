import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../daemon/logger.ts";
import { type ShippedFileState, shippedFileStates, skillsFolderPath } from "./internal_folder.ts";
import {
    type Catalog,
    type DeletedShippedSkill,
    resolveCatalog,
    type ScannedSource,
    type SkillSource,
} from "./skill_resolution.ts";

const SKILL_FILE = "SKILL.md";
const MAX_NAME_LENGTH = 64;

export type FoundSkill = { name: string; description: string; folder: string; file: string };

export type SourceScan = {
    skills: FoundSkill[];
    leftOut: { path: string; reason: string }[];
    diagnostics: string[];
    missing: boolean;
};

type Walk = { scan: SourceScan; visited: Set<string> };

const isMissingError = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
};

const byteOrder = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The Agent Skills name rule, as pi agent checks it. */
function nameProblems(name: string): string[] {
    const problems: string[] = [];
    if (name.length > MAX_NAME_LENGTH) {
        problems.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        problems.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
    }
    if (name.startsWith("-") || name.endsWith("-")) {
        problems.push("name must not start or end with a hyphen");
    }
    if (name.includes("--")) {
        problems.push("name must not contain consecutive hyphens");
    }
    return problems;
}

async function readSkill(folder: string, walk: Walk): Promise<void> {
    const file = join(folder, SKILL_FILE);
    let frontmatter: Record<string, unknown>;
    try {
        frontmatter = parseFrontmatter(await readFile(file, "utf8")).frontmatter;
    } catch (error) {
        walk.scan.leftOut.push({ path: file, reason: `can't be read or parsed: ${describeError(error)}` });
        return;
    }
    const description = frontmatter.description;
    if (typeof description !== "string" || description.trim() === "") {
        walk.scan.leftOut.push({ path: file, reason: "description is required" });
        return;
    }
    const declared = frontmatter.name;
    const name = typeof declared === "string" && declared.trim() !== "" ? declared : basename(folder);
    for (const problem of nameProblems(name)) {
        walk.scan.diagnostics.push(`${file}: skill "${name}": ${problem}`);
    }
    walk.scan.skills.push({ name, description, folder, file });
}

async function holdsSkillFile(folder: string): Promise<boolean> {
    const names = await readdir(folder);
    return names.includes(SKILL_FILE);
}

async function visit(folder: string, walk: Walk): Promise<void> {
    const real = await realpath(folder);
    if (walk.visited.has(real)) {
        return;
    }
    walk.visited.add(real);
    if (await holdsSkillFile(folder)) {
        await readSkill(folder, walk);
        return;
    }
    const names = (await readdir(folder)).sort(byteOrder);
    for (const name of names) {
        const child = join(folder, name);
        if (await isFolder(child)) {
            await visit(child, walk);
        }
    }
}

async function isFolder(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/** Walks one skill source and reads each skill it holds. Nothing is cached between calls. */
export async function discoverSkills(source: string): Promise<SourceScan> {
    const scan: SourceScan = { skills: [], leftOut: [], diagnostics: [], missing: false };
    try {
        await stat(source);
    } catch (error) {
        if (!isMissingError(error)) {
            throw error;
        }
        scan.missing = true;
        return scan;
    }
    await visit(source, { scan, visited: new Set() });
    return scan;
}

export type ReadCatalogOptions = {
    dataDir: string;
    shippedRoot: string;
    searchPaths: readonly string[];
    workspace?: string;
};

const WORKSPACE_SKILLS = join(".pi", "skills");

/** The shipped files of each skill, keyed by the skill's folder name. */
function groupBySkill(states: Record<string, ShippedFileState>): Map<string, ShippedFileState[]> {
    const groups = new Map<string, ShippedFileState[]>();
    for (const [key, state] of Object.entries(states)) {
        const [prefix, name] = key.split("/");
        if (prefix !== "skills" || name === undefined) {
            continue;
        }
        groups.set(name, [...(groups.get(name) ?? []), state]);
    }
    return groups;
}

function markShipped(catalog: Catalog, dataDir: string, states: Record<string, ShippedFileState>): void {
    const groups = groupBySkill(states);
    const internalRoot = skillsFolderPath(dataDir);
    const present = new Set<string>();
    for (const skill of catalog.skills) {
        if (skill.source.kind !== "internal") {
            continue;
        }
        const [top] = relative(internalRoot, skill.folder).split(sep);
        const files = top === undefined ? undefined : groups.get(top);
        if (top === undefined || files === undefined) {
            continue;
        }
        present.add(top);
        skill.shipped = true;
        skill.edited = files.some((file) => file.edited);
    }
    const deleted: DeletedShippedSkill[] = [];
    for (const [name, files] of groups) {
        if (!present.has(name) && files.every((file) => file.missing)) {
            deleted.push({ name, folder: join(internalRoot, name) });
        }
    }
    catalog.deletedShipped = deleted.sort((left, right) => byteOrder(left.name, right.name));
}

async function scanSource(source: SkillSource, path: string): Promise<ScannedSource> {
    const scan = await discoverSkills(path);
    if (scan.missing && source.kind === "path") {
        scan.diagnostics.push(`${path}: search path doesn't exist`);
    }
    return { source, scan };
}

/** Reads every skill source, in rising priority, and resolves their names. Nothing is cached between calls. */
export async function readCatalog(options: ReadCatalogOptions): Promise<Catalog> {
    const sources: { source: SkillSource; path: string }[] = [
        { source: { kind: "internal" }, path: skillsFolderPath(options.dataDir) },
        ...options.searchPaths.map((path): { source: SkillSource; path: string } => ({
            source: { kind: "path", path },
            path,
        })),
    ];
    if (options.workspace !== undefined) {
        const path = join(options.workspace, WORKSPACE_SKILLS);
        sources.push({ source: { kind: "workspace", path }, path });
    }
    const [scanned, states] = await Promise.all([
        Promise.all(sources.map(({ source, path }) => scanSource(source, path))),
        shippedFileStates({ dataDir: options.dataDir, shippedRoot: options.shippedRoot }),
    ]);
    const catalog = resolveCatalog(scanned);
    markShipped(catalog, options.dataDir, states);
    return catalog;
}

export type DiagnosticLog = { report(diagnostics: readonly string[]): void };

/** Logs each diagnostic once, and again only after it has gone and come back. */
export function createDiagnosticLog(logger: Logger): DiagnosticLog {
    let logged = new Set<string>();
    return {
        report(diagnostics) {
            const current = new Set(diagnostics);
            for (const diagnostic of current) {
                if (!logged.has(diagnostic)) {
                    logger.error(`skill problem: ${diagnostic}`);
                }
            }
            logged = current;
        },
    };
}
