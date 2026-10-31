import { join } from "node:path";
import {
    type LoadSkillsResult,
    loadProjectContextFiles,
    loadSkills,
    loadSkillsFromDir,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../daemon/logger.ts";
import type { Seat } from "../roles/role_model.ts";

export type WorkspaceContext = {
    contextFiles: { path: string; content: string }[];
    roleSkills: Skill[];
    workspaceSkills: Skill[];
};

// A path that does not exist holds no context file, so the service account's own pi agent folder is never read.
const EMPTY_AGENT_DIR = "/nonexistent/the-intern/pi-agent";

function logDiagnostics(logger: Logger, result: LoadSkillsResult, fallbackPath: string): void {
    for (const diagnostic of result.diagnostics) {
        logger.error("skill left out", { path: diagnostic.path ?? fallbackPath, reason: diagnostic.message });
    }
}

function loadRoleSkills(seat: Seat, logger: Logger): Skill[] {
    const skills: Skill[] = [];
    // One call per path, so a diagnostic without a path still names the folder that caused it.
    for (const skillPath of seat.skills) {
        const result = loadSkills({
            cwd: seat.workspace,
            agentDir: EMPTY_AGENT_DIR,
            skillPaths: [skillPath],
            includeDefaults: false,
        });
        logDiagnostics(logger, result, skillPath);
        skills.push(...result.skills);
    }
    return skills;
}

function loadWorkspaceSkills(workspace: string, logger: Logger): Skill[] {
    const dir = join(workspace, ".pi", "skills");
    const result = loadSkillsFromDir({ dir, source: "project" });
    logDiagnostics(logger, result, dir);
    return result.skills;
}

export function createWorkspaceContextLoader(options: { logger: Logger }): { load(seat: Seat): WorkspaceContext } {
    const { logger } = options;
    const cache = new Map<string, WorkspaceContext>();

    return {
        load(seat) {
            const cacheKey = JSON.stringify([seat.workspace, seat.skills]);
            const cached = cache.get(cacheKey);
            if (cached) return cached;
            const context: WorkspaceContext = {
                contextFiles: loadProjectContextFiles({ cwd: seat.workspace, agentDir: EMPTY_AGENT_DIR }),
                roleSkills: loadRoleSkills(seat, logger),
                workspaceSkills: loadWorkspaceSkills(seat.workspace, logger),
            };
            cache.set(cacheKey, context);
            return context;
        },
    };
}
