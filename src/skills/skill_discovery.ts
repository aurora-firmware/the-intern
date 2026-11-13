import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
