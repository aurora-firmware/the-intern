import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { Seat } from "../roles/role_model.ts";

export type PromptSection = { key: string; text: string };

export type RolePromptInput = {
    preamble: string;
    seat: Seat;
    contextFiles: { path: string; content: string }[];
    roleSkills: Skill[];
    workspaceSkills: Skill[];
};

function renderWorkspaceContext(workspace: string, contextFiles: { path: string; content: string }[]): string {
    const lines = [`Your workspace is ${workspace}.`];
    for (const file of contextFiles) {
        lines.push("", `Instructions from ${file.path}:`, "", file.content);
    }
    return lines.join("\n");
}

// Every part is a pure function of the input, so equal input renders byte-identical text and the provider cache holds.
export function renderRolePrompt(input: RolePromptInput): PromptSection[] {
    const candidates: PromptSection[] = [
        { key: "intern.preamble", text: input.preamble },
        { key: "intern.role", text: input.seat.instructions },
        { key: "intern.role-skills", text: formatSkillsForPrompt(input.roleSkills).trim() },
        {
            key: "intern.workspace-context",
            text: renderWorkspaceContext(input.seat.workspace, input.contextFiles),
        },
        { key: "intern.workspace-skills", text: formatSkillsForPrompt(input.workspaceSkills).trim() },
    ];
    return candidates.filter((section) => section.text !== "");
}
