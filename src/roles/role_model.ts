import { isAbsolute } from "node:path";
import { FRONT_DESK_TOOL_NAMES, type SeatPlace } from "../desk/desk_model.ts";
import { JOB_TOOL_NAMES } from "../jobs/job_model.ts";

export const SHIPPED_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export const COORDINATION_TOOL_NAMES = ["handoff", "invoke", "steer"] as const;
// `mail` is a tool-set entry that stands for the eight mail tools; a tool set never names one of them (S-001 REQ-003).
export const MAIL_TOOL_SET_ENTRY = "mail";
export const MAIL_TOOL_NAMES = [
    "mail_list_folders",
    "mail_search",
    "mail_read",
    "mail_save_attachments",
    "mail_move",
    "mail_set_flags",
    "mail_save_draft",
    "mail_send",
] as const;

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export type RoleDefinition = {
    name: string;
    tools: string[];
    skills: string[];
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
};

export type RoleChange = Partial<Omit<RoleDefinition, "name">>;

export type Seat = {
    role: string;
    /** `null` when nothing names a model: the seat can hold a conversation but not run a model turn (S-001 REQ-003). */
    model: string | null;
    thinkingLevel?: string;
    workspace: string;
    /** Only a document written before S-008 holds it; the prompt reads the role's file by name and no reader uses this. */
    instructions?: string;
    tools: string[];
    skills: string[];
};

export type SeatOverrides = { model?: string; thinkingLevel?: string; workspace?: string };

export type SeatDefaults = { model?: string; thinkingLevel?: string; workspace: string };

export class RoleInvalidError extends Error {
    readonly role: string;
    readonly field: string;
    readonly reason: string;

    constructor(role: string, field: string, reason: string) {
        super(`Role "${role}" is invalid at ${field}: ${reason}`);
        this.name = "RoleInvalidError";
        this.role = role;
        this.field = field;
        this.reason = reason;
    }
}

const isKnownTool = (tool: string): boolean =>
    tool === MAIL_TOOL_SET_ENTRY ||
    (SHIPPED_TOOL_NAMES as readonly string[]).includes(tool) ||
    (COORDINATION_TOOL_NAMES as readonly string[]).includes(tool) ||
    (JOB_TOOL_NAMES as readonly string[]).includes(tool);

export const isSkillName = (skill: string): boolean => skill !== "" && !skill.includes("/");

export const validateRoleDefinition = (role: RoleDefinition): void => {
    if (!ROLE_NAME_PATTERN.test(role.name)) {
        throw new RoleInvalidError(role.name, "name", `"${role.name}" does not match ${ROLE_NAME_PATTERN}`);
    }
    const unknownTool = role.tools.find((tool) => !isKnownTool(tool));
    if (unknownTool !== undefined) {
        throw new RoleInvalidError(role.name, "tools", `"${unknownTool}" is not a shipped, coordination or job tool`);
    }
    const badSkill = role.skills.find((skill) => !isSkillName(skill));
    if (badSkill !== undefined) {
        throw new RoleInvalidError(role.name, "skills", `skill name "${badSkill}" is empty or holds "/"`);
    }
    if (role.workspace !== undefined && !isAbsolute(role.workspace)) {
        throw new RoleInvalidError(role.name, "workspace", `workspace path "${role.workspace}" is not absolute`);
    }
};

export const applyRoleChange = (base: RoleDefinition, change: RoleChange): RoleDefinition => ({ ...base, ...change });

// Every seat is offered `skill`, whatever the role's tools are (S-008 REQ-008).
export const SKILL_TOOL_NAME = "skill";

const expandRoleTools = (tools: readonly string[], place: SeatPlace): string[] =>
    tools.flatMap((tool) => {
        if (tool !== MAIL_TOOL_SET_ENTRY) return [tool];
        return place === "job" ? [...MAIL_TOOL_NAMES] : [];
    });

const placeTools = (place: SeatPlace): readonly string[] => [
    ...(place === "front_desk" ? FRONT_DESK_TOOL_NAMES : [...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES]),
    SKILL_TOOL_NAME,
];

export const resolveSeat = (
    role: RoleDefinition,
    defaults: SeatDefaults,
    overrides: SeatOverrides = {},
    place: SeatPlace = "job",
): Seat => {
    return {
        role: role.name,
        model: overrides.model ?? role.model ?? defaults.model ?? null,
        thinkingLevel: overrides.thinkingLevel ?? role.thinkingLevel ?? defaults.thinkingLevel,
        workspace: overrides.workspace ?? role.workspace ?? defaults.workspace,
        tools: [...new Set([...expandRoleTools(role.tools, place), ...placeTools(place)])],
        skills: [...role.skills],
    };
};
