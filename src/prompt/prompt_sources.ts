import { readFile } from "node:fs/promises";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ConversationMeta } from "../host/seating.ts";
import { commonPromptPath, DEFAULT_SHIPPED_ROOT, roleInstructionPath } from "../skills/internal_folder.ts";
import { type DiagnosticLog, readCatalog } from "../skills/skill_discovery.ts";
import { enabledSkillsOf } from "../skills/skill_resolution.ts";
import type { PromptParts } from "./role_prompt.ts";

// A path that does not exist holds no context file, so the service account's own pi agent folder is never read.
const EMPTY_AGENT_DIR = "/nonexistent/the-intern/pi-agent";

export type PromptPartsOptions = {
    meta: ConversationMeta;
    dataDir: string;
    searchPaths: readonly string[];
    /** The skill names a role enables by default, for a document written before the enabled set. */
    defaultsOf: (role: string) => ReadonlySet<string>;
    diagnostics: DiagnosticLog;
    /** Test-only: the folder the shipped text is read from. */
    shippedRoot?: string;
};

/** The text of a prompt file, or the problem that left it out. Nothing is cached between calls. */
async function readPromptFile(path: string): Promise<{ text?: string; problem?: string }> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        return {
            problem: `${path}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "file is missing" : String(error)}`,
        };
    }
    return text.trim() === "" ? { problem: `${path}: file is empty` } : { text };
}

function problemsOf(...files: { problem?: string }[]): string[] {
    return files.flatMap((file) => (file.problem === undefined ? [] : [file.problem]));
}

/** The common prompt alone, for a conversation that has no seat document. */
export async function readCommonPrompt(options: {
    dataDir: string;
    diagnostics: DiagnosticLog;
}): Promise<string | undefined> {
    const common = await readPromptFile(commonPromptPath(options.dataDir));
    options.diagnostics.report(problemsOf(common));
    return common.text;
}

/** Reads every part of a seated conversation's prompt, in parallel, and reports what it left out. */
export async function readPromptParts(options: PromptPartsOptions): Promise<PromptParts> {
    const { meta, dataDir, searchPaths, defaultsOf, diagnostics } = options;
    const { role, workspace } = meta.seat;
    const [common, roleText, contextFiles, catalog] = await Promise.all([
        readPromptFile(commonPromptPath(dataDir)),
        readPromptFile(roleInstructionPath(dataDir, role)),
        Promise.resolve().then(() => loadProjectContextFiles({ cwd: workspace, agentDir: EMPTY_AGENT_DIR })),
        readCatalog({ dataDir, shippedRoot: options.shippedRoot ?? DEFAULT_SHIPPED_ROOT, searchPaths, workspace }),
    ]);
    diagnostics.report([...problemsOf(common, roleText), ...catalog.diagnostics]);
    const { enabled } = enabledSkillsOf(catalog, new Set(meta.enabledSkills ?? defaultsOf(role)));
    return { common: common.text, role: roleText.text, isLead: meta.isLead, workspace, contextFiles, skills: enabled };
}
