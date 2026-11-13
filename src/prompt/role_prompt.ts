import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { JOB_TOOL_NAMES } from "../jobs/job_model.ts";
import type { Seat } from "../roles/role_model.ts";
import type { CatalogSkill } from "../skills/skill_resolution.ts";

export type PromptSection = { key: string; text: string };

export type RolePromptInput = {
    preamble: string;
    seat: Seat;
    isLead: boolean;
    contextFiles: { path: string; content: string }[];
    roleSkills: Skill[];
    workspaceSkills: Skill[];
};

type JobToolName = (typeof JOB_TOOL_NAMES)[number];
const UPDATE_JOB: JobToolName = "update_job";
const BLOCK_JOB: JobToolName = "block_job";
const COMPLETE_JOB: JobToolName = "complete_job";
const READ_SCHEDULE_RUNS: JobToolName = "read_schedule_runs";

// The lead's first duty (S-004 REQ-008). One constant, so the prompt section and the lead's first input say the same.
export const LEAD_DUTY = [
    "You are the lead of this job. Your first duty is to make sure the job has a definition of done.",
    `If it has none, write one with ${UPDATE_JOB}.`,
    `If you can't write one, block the job with ${BLOCK_JOB} and give the reason.`,
    `Before you complete the job with ${COMPLETE_JOB}, check the result against the definition of done`,
    "and state the evidence in the justification.",
].join(" ");

// What a scheduled run's lead is told about its origin (S-007 REQ-010). A pure function of the entry name, so the first
// input is the same each time it is built.
export function scheduledRunNotice(entry: string): string {
    return [
        `This job is a scheduled run of the schedule entry ${entry}.`,
        `Earlier scheduled runs of ${entry} can be read: call ${READ_SCHEDULE_RUNS} with the name ${entry}.`,
    ].join(" ");
}

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

export type PromptParts = {
    common?: string;
    role?: string;
    isLead: boolean;
    workspace: string;
    contextFiles: { path: string; content: string }[];
    skills: CatalogSkill[];
};

// Escapes as pi agent's formatSkillsForPrompt does.
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

const SKILL_LISTING_INTRO = [
    "The following skills provide specialized instructions for specific tasks.",
    "When the task matches a skill's description, load the skill with the `skill` tool and its `name`.",
    "To read a file the skill names, call the `skill` tool with the skill's `name` and `file`, relative to the skill's folder.",
].join("\n");

// Sorted by name in byte order (UTF-8), so equal skills render byte-identical text.
export function renderSkillListing(skills: CatalogSkill[]): string {
    const sorted = [...skills].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const lines = [SKILL_LISTING_INTRO, "", "<available_skills>"];
    for (const skill of sorted) {
        lines.push(
            "  <skill>",
            `    <name>${escapeXml(skill.name)}</name>`,
            `    <description>${escapeXml(skill.description)}</description>`,
            `    <location>${escapeXml(skill.file)}</location>`,
            "  </skill>",
        );
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}

// Pure: equal parts render byte-identical sections, and the skills are the only part that varies with the catalog.
export function renderPromptSections(parts: PromptParts): PromptSection[] {
    const candidates: PromptSection[] = [
        { key: "intern-common", text: parts.common ?? "" },
        { key: "intern-role", text: parts.role ?? "" },
        { key: "intern-lead-duty", text: parts.isLead ? LEAD_DUTY : "" },
        { key: "intern-workspace-context", text: renderWorkspaceContext(parts.workspace, parts.contextFiles) },
        { key: "intern-skills", text: parts.skills.length === 0 ? "" : renderSkillListing(parts.skills) },
    ];
    return candidates.filter((section) => section.text !== "");
}
