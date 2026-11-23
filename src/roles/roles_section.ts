import { isAbsolute } from "node:path";
import { ConfigValueError, defineConfigSection } from "../config/config_file.ts";
import { type RoleChange, type RoleDefinition, RoleInvalidError, validateRoleDefinition } from "./role_model.ts";
import { SHIPPED_ROLE_NAMES } from "./shipped_roles.ts";

// Keys an older configuration file holds that the role definition no longer has; the conversion reads them.
export type OlderRoleKeys = { instructions?: string; skillPaths?: string[] };

export type RolesConfig = {
    teamRoles: Record<string, RoleDefinition>;
    shippedChanges: Record<string, RoleChange>;
    older: Record<string, OlderRoleKeys>;
};

export type WorkspacesConfig = { registered: string[] };

const ROLE_KEYS = ["instructions", "tools", "skills", "model", "thinking_level", "workspace"];

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isShippedRole = (name: string): boolean => (SHIPPED_ROLE_NAMES as readonly string[]).includes(name);

const readString = (table: Table, role: string, field: string): string | undefined => {
    const value = table[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new ConfigValueError(`${role}.${field}`, "must be a string");
    return value;
};

const readStringList = (table: Table, role: string, field: string): string[] | undefined => {
    const value = table[field];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ConfigValueError(`${role}.${field}`, "must be a list of strings");
    }
    return value as string[];
};

const isOlderSkillPath = (skill: string): boolean => isAbsolute(skill);

const readOlderKeys = (role: string, table: Table): OlderRoleKeys => {
    const older: OlderRoleKeys = {};
    const instructions = readString(table, role, "instructions");
    if (instructions !== undefined) {
        if (instructions.trim() === "") throw new ConfigValueError(`${role}.instructions`, "instructions are empty");
        older.instructions = instructions;
    }
    const skillPaths = (readStringList(table, role, "skills") ?? []).filter(isOlderSkillPath);
    if (skillPaths.length > 0) older.skillPaths = skillPaths;
    return older;
};

const readRoleChange = (role: string, table: Table): RoleChange => {
    const unknownKey = Object.keys(table).find((key) => !ROLE_KEYS.includes(key));
    if (unknownKey !== undefined) throw new ConfigValueError(`${role}.${unknownKey}`, "is not a role setting");
    const change: RoleChange = {};
    const tools = readStringList(table, role, "tools");
    const skills = readStringList(table, role, "skills")?.filter((skill) => !isOlderSkillPath(skill));
    const model = readString(table, role, "model");
    const thinkingLevel = readString(table, role, "thinking_level");
    const workspace = readString(table, role, "workspace");
    if (tools !== undefined) change.tools = tools;
    if (skills !== undefined) change.skills = skills;
    if (model !== undefined) change.model = model;
    if (thinkingLevel !== undefined) change.thinkingLevel = thinkingLevel;
    if (workspace !== undefined) change.workspace = workspace;
    return change;
};

// Validation runs on the change merged into a valid stand-in, so only the changed fields can fail.
const validateChange = (role: string, change: RoleChange): void => {
    validateWithKey(role, { name: "stand-in", tools: [], skills: [], ...change });
};

const validateWithKey = (role: string, definition: RoleDefinition): void => {
    try {
        validateRoleDefinition(definition);
    } catch (error) {
        if (error instanceof RoleInvalidError) throw new ConfigValueError(`${role}.${error.field}`, error.reason);
        throw error;
    }
};

const readTeamRole = (name: string, table: Table): RoleDefinition => {
    const change = readRoleChange(name, table);
    if (change.tools === undefined) throw new ConfigValueError(`${name}.tools`, "is required");
    const role: RoleDefinition = {
        name,
        ...change,
        tools: change.tools,
        skills: change.skills ?? [],
    };
    validateWithKey(name, role);
    return role;
};

const serializeChange = (change: RoleChange): Table => {
    const table: Table = {};
    if (change.tools !== undefined) table.tools = change.tools;
    if (change.skills !== undefined) table.skills = change.skills;
    if (change.model !== undefined) table.model = change.model;
    if (change.thinkingLevel !== undefined) table.thinking_level = change.thinkingLevel;
    if (change.workspace !== undefined) table.workspace = change.workspace;
    return table;
};

// A file is rewritten unchanged until the conversion runs: the names first, then the older paths.
const withOlderPaths = (names: string[], older: OlderRoleKeys | undefined): string[] => [
    ...names,
    ...(older?.skillPaths ?? []),
];

const olderText = (older: OlderRoleKeys | undefined): Table =>
    older?.instructions === undefined ? {} : { instructions: older.instructions };

export const rolesSection = defineConfigSection<RolesConfig>({
    name: "roles",
    defaults: () => ({ teamRoles: {}, shippedChanges: {}, older: {} }),
    parse(table) {
        if (!isTable(table)) throw new ConfigValueError("roles", "must be a table");
        const value: RolesConfig = { teamRoles: {}, shippedChanges: {}, older: {} };
        for (const [name, roleTable] of Object.entries(table)) {
            if (!isTable(roleTable)) throw new ConfigValueError(name, "must be a table");
            const older = readOlderKeys(name, roleTable);
            if (Object.keys(older).length > 0) value.older[name] = older;
            if (isShippedRole(name)) {
                const change = readRoleChange(name, roleTable);
                validateChange(name, change);
                value.shippedChanges[name] = change;
            } else {
                value.teamRoles[name] = readTeamRole(name, roleTable);
            }
        }
        return value;
    },
    serialize(value) {
        const table: Table = {};
        for (const [name, role] of Object.entries(value.teamRoles)) {
            const { name: _name, ...fields } = role;
            const skills = withOlderPaths(fields.skills, value.older[name]);
            table[name] = {
                ...olderText(value.older[name]),
                ...serializeChange({ ...fields, skills: skills.length === 0 ? undefined : skills }),
            };
        }
        for (const [name, change] of Object.entries(value.shippedChanges)) {
            const older = value.older[name];
            const skills = change.skills && withOlderPaths(change.skills, older);
            table[name] = { ...olderText(older), ...serializeChange({ ...change, skills }) };
        }
        return table;
    },
});

const readRegistered = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ConfigValueError("registered", "must be a list of absolute folder paths");
    }
    const seen = new Set<string>();
    for (const path of value as string[]) {
        if (!isAbsolute(path)) throw new ConfigValueError("registered", `path "${path}" is not absolute`);
        if (seen.has(path)) throw new ConfigValueError("registered", `path "${path}" is listed twice`);
        seen.add(path);
    }
    return [...value];
};

export const workspacesSection = defineConfigSection<WorkspacesConfig>({
    name: "workspaces",
    defaults: () => ({ registered: [] }),
    parse(table) {
        if (!isTable(table)) throw new ConfigValueError("workspaces", "must be a table");
        const unknownKey = Object.keys(table).find((key) => key !== "registered");
        if (unknownKey !== undefined) throw new ConfigValueError(unknownKey, "is not a workspaces setting");
        return { registered: table.registered === undefined ? [] : readRegistered(table.registered) };
    },
    serialize: (value) => ({ registered: value.registered }),
});
