import { isAbsolute } from "node:path";
import { FRONT_DESK_TOOL_NAMES, type SeatPlace } from "../desk/desk_model.ts";
import { JOB_TOOL_NAMES } from "../jobs/job_model.ts";

export const SHIPPED_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export const COORDINATION_TOOL_NAMES = ["handoff", "invoke", "steer"] as const;

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export type RoleDefinition = {
    name: string;
    instructions: string;
    tools: string[];
    skills: string[];
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
};

export type RoleChange = Partial<Omit<RoleDefinition, "name">>;

export type Seat = {
    role: string;
    model: string;
    thinkingLevel?: string;
    workspace: string;
    instructions: string;
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
    (SHIPPED_TOOL_NAMES as readonly string[]).includes(tool) ||
    (COORDINATION_TOOL_NAMES as readonly string[]).includes(tool) ||
    (JOB_TOOL_NAMES as readonly string[]).includes(tool);

export const validateRoleDefinition = (role: RoleDefinition): void => {
    if (!ROLE_NAME_PATTERN.test(role.name)) {
        throw new RoleInvalidError(role.name, "name", `"${role.name}" does not match ${ROLE_NAME_PATTERN}`);
    }
    if (role.instructions.trim() === "") {
        throw new RoleInvalidError(role.name, "instructions", "instructions are empty");
    }
    const unknownTool = role.tools.find((tool) => !isKnownTool(tool));
    if (unknownTool !== undefined) {
        throw new RoleInvalidError(role.name, "tools", `"${unknownTool}" is not a shipped, coordination or job tool`);
    }
    const relativeSkill = role.skills.find((skill) => !isAbsolute(skill));
    if (relativeSkill !== undefined) {
        throw new RoleInvalidError(role.name, "skills", `skill path "${relativeSkill}" is not absolute`);
    }
    if (role.workspace !== undefined && !isAbsolute(role.workspace)) {
        throw new RoleInvalidError(role.name, "workspace", `workspace path "${role.workspace}" is not absolute`);
    }
};

export const applyRoleChange = (base: RoleDefinition, change: RoleChange): RoleDefinition => ({ ...base, ...change });

const placeTools = (place: SeatPlace): readonly string[] =>
    place === "front_desk" ? FRONT_DESK_TOOL_NAMES : [...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES];

export const resolveSeat = (
    role: RoleDefinition,
    defaults: SeatDefaults,
    overrides: SeatOverrides = {},
    place: SeatPlace = "job",
): Seat => {
    const model = overrides.model ?? role.model ?? defaults.model;
    if (model === undefined) {
        throw new RoleInvalidError(role.name, "model", "no override, role default or pi agent default names a model");
    }
    return {
        role: role.name,
        model,
        thinkingLevel: overrides.thinkingLevel ?? role.thinkingLevel ?? defaults.thinkingLevel,
        workspace: overrides.workspace ?? role.workspace ?? defaults.workspace,
        instructions: role.instructions,
        tools: [...new Set([...role.tools, ...placeTools(place)])],
        skills: [...role.skills],
    };
};
