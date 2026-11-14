/**
 * The `skill` tool (S-008 REQ-008, REQ-016): an agent loads the text of a skill enabled for it, or a file the skill
 * bundles. It only reads, so a call cut short by a restart is safe to run again.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type Static, Type } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import {
    defineExtension,
    defineTool,
    type Extension,
    type ToolExecutionApi,
    type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { conversationMetaDoc } from "../host/seating.ts";
import { SKILL_TOOL_NAME } from "../roles/role_model.ts";
import { type Catalog, type CatalogSkill, enabledSkillsOf } from "./skill_resolution.ts";

export { SKILL_TOOL_NAME };
export const SKILL_TOOL_EXTENSION_NAME = "intern.skill-tool";

const BYTES_PER_KIB = 1024;
// The cut text and its closing line (a blank line and the notice) must reach the model whole, so the harness's own
// limit on a tool's output, which has the same values, leaves room for the line.
const CLOSING_LINES = 2;
const CLOSING_BYTES = 512;

export type SkillToolOptions = {
    /** The catalog for a seat's workspace, read afresh at each call. */
    catalogFor: (workspace: string) => Promise<Catalog>;
    /** The skill names a role enables by default, for a document written before the enabled set, as the prompt does. */
    defaultsOf: (role: string) => ReadonlySet<string>;
};

const parameters = Type.Object({
    name: Type.String({ description: "The name of the skill, as the listing in your instructions gives it." }),
    file: Type.Optional(
        Type.String({
            description:
                "A file the skill names, relative to the skill's folder. Without it you get the skill's SKILL.md.",
        }),
    ),
});

const refusal = (message: string): ToolExecutionResult => ({
    output: [{ type: "text", text: `skill was refused: ${message}` }],
    isError: true,
});

const isInside = (folder: string, path: string): boolean => {
    const from = relative(folder, path);
    return from !== ".." && !from.startsWith(`..${"/"}`) && !isAbsolute(from);
};

const describeCut = (cut: ReturnType<typeof truncateHead>): string =>
    `[Showing the first ${cut.outputLines} of ${cut.totalLines} lines; the text is cut at ${DEFAULT_MAX_LINES} lines or ` +
    `${DEFAULT_MAX_BYTES / BYTES_PER_KIB}KB.]`;

function textOf(content: string): ToolExecutionResult {
    const cut = truncateHead(content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    const text = cut.truncated ? `${cut.content}\n\n${describeCut(cut)}` : cut.content;
    return { output: [{ type: "text", text }] };
}

type Located = { path: string } | { problem: string };

// The real path of the file must lie under the real path of the skill's folder, so a link can't lead out of it.
async function locateFile(skill: CatalogSkill, file: string): Promise<Located> {
    if (isAbsolute(file)) return { problem: `${file} is not inside the skill's folder; give a path relative to it` };
    const target = resolve(skill.folder, file);
    let realFolder: string;
    let realTarget: string;
    try {
        realFolder = await realpath(skill.folder);
        realTarget = await realpath(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { problem: `${file} is missing: no such file` };
        throw error;
    }
    if (!isInside(realFolder, realTarget)) return { problem: `${file} is not inside the skill's folder` };
    if (!(await stat(realTarget)).isFile()) return { problem: `${file} is not a file` };
    return { path: realTarget };
}

async function callSkill(
    options: SkillToolOptions,
    args: Static<typeof parameters>,
    api: ToolExecutionApi,
    context: Context,
): Promise<ToolExecutionResult> {
    const meta = await api.snapshot(conversationMetaDoc, api.conversationId, context);
    if (meta === undefined || meta.jobId === "")
        return refusal("this conversation has no seat, so no skill is enabled.");
    const catalog = await options.catalogFor(meta.seat.workspace);
    const { enabled } = enabledSkillsOf(catalog, new Set(meta.enabledSkills ?? options.defaultsOf(meta.seat.role)));
    const skill = enabled.find((candidate) => candidate.name === args.name);
    if (skill === undefined) {
        return refusal(
            `the skill ${args.name} is not enabled for you; enabled: ${enabled.map((s) => s.name).join(", ")}.`,
        );
    }
    const located = await locateFile(skill, args.file ?? basename(skill.file));
    return "problem" in located ? refusal(located.problem) : textOf(await readFile(located.path, "utf8"));
}

export function createSkillToolExtension(options: SkillToolOptions): Extension {
    const tool = defineTool({
        name: SKILL_TOOL_NAME,
        description:
            "Load the instructions of a skill enabled for you, by name, when your task matches its description. " +
            "Pass `file` to read a file the skill names instead, relative to the skill's folder.",
        parameters,
        replay: "safe",
        outputLimits: {
            maxLines: DEFAULT_MAX_LINES + CLOSING_LINES,
            maxBytes: DEFAULT_MAX_BYTES + CLOSING_BYTES,
            retain: "head",
        },
        execute: (args, api, context) => callSkill(options, args, api, context),
    });
    return defineExtension({ name: SKILL_TOOL_EXTENSION_NAME, tools: [tool] });
}
