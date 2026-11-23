import { isAbsolute } from "node:path";
import { ConfigValueError, defineConfigSection } from "../config/config_file.ts";
import { checkWorkspaceFolder, WorkspaceFolderError } from "../workspaces/workspace_folder.ts";

export type SkillsConfig = { paths: string[] };

const OWNER_ONLY_REASON = "the folder must be accessible only to the service account";
const OTHER_ACCOUNT_REASONS = ["accessible to the group or others", "not owned by the service account"];

export class SearchPathError extends Error {
    path: string;
    reason: string;

    constructor(path: string, reason: string) {
        super(`Skill search path ${path}: ${reason}`);
        this.name = "SearchPathError";
        this.path = path;
        this.reason = reason;
    }
}

/** Resolves when the folder may be a skill search path; otherwise throws a SearchPathError. */
export async function checkSearchPath(path: string): Promise<void> {
    try {
        await checkWorkspaceFolder(path, { uid: process.getuid?.() ?? 0 });
    } catch (error) {
        if (!(error instanceof WorkspaceFolderError)) throw error;
        const reason = OTHER_ACCOUNT_REASONS.includes(error.reason) ? OWNER_ONLY_REASON : error.reason;
        throw new SearchPathError(path, reason);
    }
}

const readPaths = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ConfigValueError("paths", "must be a list of absolute folder paths");
    }
    const seen = new Set<string>();
    for (const path of value as string[]) {
        if (!isAbsolute(path)) throw new ConfigValueError("paths", `path "${path}" is not absolute`);
        if (seen.has(path)) throw new ConfigValueError("paths", `path "${path}" is listed twice`);
        seen.add(path);
    }
    return [...value];
};

export const skillsSection = defineConfigSection<SkillsConfig>({
    name: "skills",
    defaults: () => ({ paths: [] }),
    parse(table) {
        if (typeof table !== "object" || table === null || Array.isArray(table)) {
            throw new ConfigValueError("skills", "must be a table");
        }
        const record = table as Record<string, unknown>;
        const unknownKey = Object.keys(record).find((key) => key !== "paths");
        if (unknownKey !== undefined) throw new ConfigValueError(unknownKey, "is not a skills setting");
        return { paths: record.paths === undefined ? [] : readPaths(record.paths) };
    },
    async check(value) {
        for (const path of value.paths) {
            try {
                await checkSearchPath(path);
            } catch (error) {
                if (error instanceof SearchPathError) {
                    throw new ConfigValueError("paths", `${path}: ${error.reason}`);
                }
                throw error;
            }
        }
    },
    serialize: (value) => ({ paths: value.paths }),
});
