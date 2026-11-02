import { isAbsolute } from "node:path";
import type { ConfigStore } from "../config/config_writer.ts";
import { JOB_TOOL_NAMES } from "../jobs/job_model.ts";
import type { InternModels } from "../models/model_runtime.ts";
import { roleWorkspacePath } from "../workspaces/workspace_folder.ts";
import type { WorkspaceRegistry } from "../workspaces/workspace_registry.ts";
import {
    applyRoleChange,
    COORDINATION_TOOL_NAMES,
    type RoleChange,
    type RoleDefinition,
    RoleInvalidError,
    resolveSeat,
    type Seat,
    type SeatOverrides,
    SHIPPED_TOOL_NAMES,
    validateRoleDefinition,
} from "./role_model.ts";
import { type RolesConfig, rolesSection } from "./roles_section.ts";

export type CatalogRole = RoleDefinition & { shipped: boolean; changed: boolean };

export type RoleReferenceSource = { name: string; referrersOf(role: string): string[] };

export type RoleCatalog = {
    list(): CatalogRole[];
    get(name: string): CatalogRole | undefined;
    create(role: RoleDefinition): Promise<CatalogRole>;
    change(name: string, change: RoleChange): Promise<CatalogRole>;
    restore(name: string): Promise<CatalogRole>;
    remove(name: string): Promise<void>;
    addReferenceSource(source: RoleReferenceSource): void;
    seatFor(name: string, overrides?: SeatOverrides): Seat;
    defaultWorkspaceUsers(path: string): string[];
    checkConfigured(): void;
};

export type RoleCatalogOptions = {
    config: ConfigStore;
    shipped: RoleDefinition[];
    workspaces: WorkspaceRegistry;
    models: Pick<InternModels, "checkModelChoice" | "defaultChoice">;
    dataDir: string;
};

export type RoleRefusalKind = "not_found" | "invalid" | "conflict";

export class RoleRefusedError extends Error {
    kind: RoleRefusalKind;
    role: string;
    field?: string;
    value?: string;
    reason: string;

    constructor(kind: RoleRefusalKind, role: string, reason: string, field?: string, value?: string) {
        super(
            field === undefined
                ? `Role "${role}": ${reason}`
                : `Role "${role}" ${field}${value === undefined ? "" : ` "${value}"`}: ${reason}`,
        );
        this.name = "RoleRefusedError";
        this.kind = kind;
        this.role = role;
        this.field = field;
        this.value = value;
        this.reason = reason;
    }
}

const describeValue = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value.join(", ") : String(value);
};

const KNOWN_TOOLS: readonly string[] = [...SHIPPED_TOOL_NAMES, ...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES];

// For a list field the value is the offending entry, so the refusal names what to fix.
const offendingValue = (role: RoleDefinition, field: string): string | undefined => {
    if (field === "tools") return role.tools.find((tool) => !KNOWN_TOOLS.includes(tool));
    if (field === "skills") return role.skills.find((skill) => !isAbsolute(skill));
    return describeValue(role[field as keyof RoleDefinition]);
};

export function createRoleCatalog(options: RoleCatalogOptions): RoleCatalog {
    const { config, shipped, workspaces, models, dataDir } = options;
    const referenceSources: RoleReferenceSource[] = [];

    const current = (): RolesConfig => config.current(rolesSection);

    const effective = (name: string): CatalogRole | undefined => {
        const base = shipped.find((role) => role.name === name);
        if (base !== undefined) {
            const change = current().shippedChanges[name];
            return { ...applyRoleChange(base, change ?? {}), shipped: true, changed: change !== undefined };
        }
        const team = current().teamRoles[name];
        return team === undefined ? undefined : { ...team, shipped: false, changed: false };
    };

    const list = (): CatalogRole[] => [
        ...shipped.map((role) => effective(role.name) as CatalogRole),
        ...Object.keys(current().teamRoles).map((name) => effective(name) as CatalogRole),
    ];

    const requireRole = (name: string): CatalogRole => {
        const role = effective(name);
        if (role === undefined) throw new RoleRefusedError("not_found", name, "there is no such role");
        return role;
    };

    const refuseField = (role: string, field: string, value: unknown, reason: string): never => {
        throw new RoleRefusedError("invalid", role, reason, field, describeValue(value));
    };

    const checkModelAndLevel = (role: string, model: string | undefined, thinkingLevel: string | undefined): void => {
        if (model === undefined) return;
        const modelCheck = models.checkModelChoice({ model });
        if (!modelCheck.ok) refuseField(role, "model", model, modelCheck.reason);
        if (thinkingLevel === undefined) return;
        const levelCheck = models.checkModelChoice({ model, thinkingLevel });
        if (!levelCheck.ok) refuseField(role, "thinkingLevel", thinkingLevel, levelCheck.reason);
    };

    const checkWorkspace = (role: string, workspace: string | undefined): void => {
        if (workspace !== undefined && !workspaces.isRegistered(workspace)) {
            refuseField(role, "workspace", workspace, "the workspace is not registered");
        }
    };

    // A thinking level without a model of its own is checked against pi agent's default model.
    const checkChoices = (role: string, choices: SeatOverrides & { model?: string }): void => {
        const model = choices.model ?? models.defaultChoice()?.model;
        checkModelAndLevel(role, model, choices.thinkingLevel);
        checkWorkspace(role, choices.workspace);
    };

    const checkDefinition = (role: RoleDefinition): void => {
        try {
            validateRoleDefinition(role);
        } catch (error) {
            if (!(error instanceof RoleInvalidError)) throw error;
            throw new RoleRefusedError(
                "invalid",
                role.name,
                error.reason,
                error.field,
                offendingValue(role, error.field),
            );
        }
        checkChoices(role.name, role);
    };

    const saveChange = async (name: string, next: RolesConfig): Promise<CatalogRole> => {
        await config.change(rolesSection, next);
        return requireRole(name);
    };

    return {
        list,
        get: effective,
        async create(role) {
            if (effective(role.name) !== undefined) {
                throw new RoleRefusedError("conflict", role.name, "a role with this name already exists");
            }
            checkDefinition(role);
            const definition = { ...role };
            if (definition.workspace === undefined) await workspaces.ensureRoleDefault(role.name);
            return saveChange(role.name, {
                ...current(),
                teamRoles: { ...current().teamRoles, [role.name]: definition },
            });
        },
        async change(name, change) {
            const role = requireRole(name);
            const { shipped: _shipped, changed: _changed, ...definition } = role;
            checkDefinition(applyRoleChange(definition, change));
            if (role.shipped) {
                const merged = { ...current().shippedChanges[name], ...change };
                return saveChange(name, {
                    ...current(),
                    shippedChanges: { ...current().shippedChanges, [name]: merged },
                });
            }
            const next = applyRoleChange(current().teamRoles[name] as RoleDefinition, change);
            return saveChange(name, { ...current(), teamRoles: { ...current().teamRoles, [name]: next } });
        },
        async restore(name) {
            const role = requireRole(name);
            if (!role.shipped) throw new RoleRefusedError("conflict", name, "it is a team role, not a shipped role");
            const { [name]: _dropped, ...remaining } = current().shippedChanges;
            return saveChange(name, { ...current(), shippedChanges: remaining });
        },
        async remove(name) {
            const role = requireRole(name);
            if (role.shipped) throw new RoleRefusedError("conflict", name, "a shipped role can't be removed");
            const referrers = referenceSources.flatMap((source) =>
                source.referrersOf(name).map((referrer) => `${source.name}: ${referrer}`),
            );
            if (referrers.length > 0) {
                throw new RoleRefusedError("conflict", name, `it is named by ${referrers.join(", ")}`);
            }
            const { [name]: _removed, ...remaining } = current().teamRoles;
            await config.change(rolesSection, { ...current(), teamRoles: remaining });
        },
        addReferenceSource(source) {
            referenceSources.push(source);
        },
        seatFor(name, overrides = {}) {
            const { shipped: _shipped, changed: _changed, ...role } = requireRole(name);
            checkDefinition(role);
            const defaults = models.defaultChoice();
            checkChoices(name, {
                model: overrides.model ?? role.model,
                thinkingLevel: overrides.thinkingLevel ?? role.thinkingLevel,
                workspace: overrides.workspace,
            });
            try {
                return resolveSeat(role, { ...defaults, workspace: roleWorkspacePath(dataDir, name) }, overrides);
            } catch (error) {
                if (!(error instanceof RoleInvalidError)) throw error;
                throw new RoleRefusedError("invalid", name, error.reason, error.field);
            }
        },
        defaultWorkspaceUsers: (path) =>
            list()
                .filter((role) => role.workspace === path)
                .map((role) => role.name),
        checkConfigured() {
            for (const role of list())
                checkChoices(role.name, { model: role.model, thinkingLevel: role.thinkingLevel });
        },
    };
}
