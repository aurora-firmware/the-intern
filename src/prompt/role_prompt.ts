import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { Seat } from "../roles/role_model.ts";

export type PromptSection = { key: string; text: string };

export type RolePromptInput = {
    preamble: string;
    seat: Seat;
    isLead: boolean;
    contextFiles: { path: string; content: string }[];
    roleSkills: Skill[];
    workspaceSkills: Skill[];
};

// The lead's first duty (S-004 REQ-008). One constant, so the prompt section and the lead's first input say the same.
export const LEAD_DUTY = [
    "You are the lead of this job. Your first duty is to make sure the job has a definition of done.",
    "If it has none, write one with update_job.",
    "If you can't write one, block the job with block_job and give the reason.",
    "Before you complete the job with complete_job, check the result against the definition of done",
    "and state the evidence in the justification.",
].join(" ");

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
        { key: "intern.lead-duty", text: input.isLead ? LEAD_DUTY : "" },
        { key: "intern.role-skills", text: formatSkillsForPrompt(input.roleSkills).trim() },
        {
            key: "intern.workspace-context",
            text: renderWorkspaceContext(input.seat.workspace, input.contextFiles),
        },
        { key: "intern.workspace-skills", text: formatSkillsForPrompt(input.workspaceSkills).trim() },
    ];
    return candidates.filter((section) => section.text !== "");
}
