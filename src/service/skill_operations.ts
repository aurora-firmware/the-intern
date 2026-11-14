/**
 * The skills operations (S-008 REQ-009): `skills.list` reads the catalog a role or a seated agent sees, with each
 * skill's source, whether it is enabled, the copies it shadows, and the skills left out. It returns no file text.
 */

import { isDeepStrictEqual } from "node:util";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { ConversationClosedError } from "../host/job_section.ts";
import { readConversationMeta } from "../host/seating.ts";
import { setEnabledSkill } from "../host/skill_set.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import type { Seat } from "../roles/role_model.ts";
import { type RolesConfig, rolesSection } from "../roles/roles_section.ts";
import { SHIPPED_ROLE_NAMES } from "../roles/shipped_roles.ts";
import { readCatalog } from "../skills/skill_discovery.ts";
import { type CatalogSkill, enabledSkillsOf, type SkillSource } from "../skills/skill_resolution.ts";
import type { SkillsComponent } from "../skills/skills_component.ts";
import { skillsSection } from "../skills/skills_section.ts";
import { roleWorkspacePath } from "../workspaces/workspace_folder.ts";
import { type Caller, defineOperation, type Operation, ServiceError } from "./operations.ts";
import { seatActorFor } from "./seat_operations.ts";

type ListInput = { role: string } | { conversation: string };

type ChangeInput = { name: string } & ({ role: string } | { conversation: string });

type ListedSkill = {
    name: string;
    description: string;
    source: SkillSource;
    path: string;
    enabled: boolean;
    shipped: boolean;
    edited: boolean;
    deleted?: true;
    shadowed: { path: string; source: SkillSource }[];
};

type SkillListing = {
    skills: ListedSkill[];
    missing: string[];
    leftOut: { path: string; reason: string }[];
    seat?: Pick<Seat, "role" | "model" | "thinkingLevel" | "workspace">;
};

function parseList(raw: unknown): ListInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { role, conversation } = raw as Record<string, unknown>;
    if ((role === undefined) === (conversation === undefined)) {
        throw new Error("give exactly one of role or conversation");
    }
    if (role !== undefined) {
        if (typeof role !== "string" || role === "") throw new Error("role must be a non-empty string");
        return { role };
    }
    if (typeof conversation !== "string" || conversation === "") {
        throw new Error("conversation must be a non-empty string");
    }
    return { conversation };
}

function parseChange(raw: unknown): ChangeInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { name, ...target } = raw as Record<string, unknown>;
    if (typeof name !== "string" || name === "") throw new Error("name must be a non-empty string");
    return { name, ...parseList(target) };
}

const isShippedRole = (role: string): boolean => (SHIPPED_ROLE_NAMES as readonly string[]).includes(role);

/** The roles section with the role's skills replaced; a shipped role's change keeps its other changed settings. */
function withRoleSkills(current: RolesConfig, role: string, skills: string[]): RolesConfig {
    if (isShippedRole(role)) {
        return {
            ...current,
            shippedChanges: { ...current.shippedChanges, [role]: { ...current.shippedChanges[role], skills } },
        };
    }
    const team = current.teamRoles[role];
    if (team === undefined) throw new ServiceError("not_found", `There is no role ${role}`);
    return { ...current, teamRoles: { ...current.teamRoles, [role]: { ...team, skills } } };
}

const refusalCodes = { invalid: "invalid_input", conflict: "conflict", write_failed: "internal" } as const;

function listedSkill(skill: CatalogSkill, enabled: boolean): ListedSkill {
    return {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.folder,
        enabled,
        shipped: skill.shipped,
        edited: skill.edited,
        shadowed: skill.shadowed,
    };
}

export function skillOperations(component: SkillsComponent) {
    type Target = { workspace: string; enabledNames: ReadonlySet<string>; seat?: SkillListing["seat"] };

    const roleTarget = (role: string): Target => {
        const { catalog } = component.agentsRuntime();
        const found = catalog.get(role);
        if (found === undefined) throw new ServiceError("not_found", `There is no role ${role}`);
        return {
            workspace: found.workspace ?? roleWorkspacePath(component.dataDir(), role),
            enabledNames: new Set(found.skills),
        };
    };

    const conversationTarget = async ({ host }: ServiceContext, conversation: string): Promise<Target> => {
        const meta = await readConversationMeta(host, conversation);
        if (meta === undefined) throw new ServiceError("not_found", `There is no seated conversation ${conversation}`);
        const { role, model, thinkingLevel, workspace } = meta.seat;
        const defaults = component.agentsRuntime().catalog.get(role)?.skills ?? [];
        return {
            workspace,
            enabledNames: new Set(meta.enabledSkills ?? defaults),
            seat: { role, model, ...(thinkingLevel !== undefined && { thinkingLevel }), workspace },
        };
    };

    const listOperation = defineOperation<ServiceContext, ListInput, SkillListing>({
        name: "skills.list",
        kind: "read",
        parse: parseList,
        async run(ctx, input) {
            const target = "role" in input ? roleTarget(input.role) : await conversationTarget(ctx, input.conversation);
            const catalog = await readCatalog({
                dataDir: component.dataDir(),
                shippedRoot: component.shippedRoot,
                searchPaths: ctx.config.current(skillsSection).paths,
                workspace: target.workspace,
            });
            const { enabled, missing } = enabledSkillsOf(catalog, target.enabledNames);
            const enabledNames = new Set(enabled.map((skill) => skill.name));
            const skills = catalog.skills.map((skill) => listedSkill(skill, enabledNames.has(skill.name)));
            for (const deleted of catalog.deletedShipped) {
                skills.push({
                    name: deleted.name,
                    description: "",
                    source: { kind: "internal" },
                    path: deleted.folder,
                    enabled: target.enabledNames.has(deleted.name),
                    shipped: true,
                    edited: true,
                    deleted: true,
                    shadowed: [],
                });
            }
            return {
                skills,
                missing,
                leftOut: catalog.leftOut,
                ...(target.seat !== undefined && { seat: target.seat }),
            };
        },
    });

    /** Writes the role's new list through one `ConfigStore.update`; a list that stays the same writes nothing. */
    const changeRoleSkills = async (
        { config }: ServiceContext,
        role: string,
        change: (skills: readonly string[]) => string[],
    ): Promise<{ enabledSkills: string[] }> => {
        const unchanged = Symbol("unchanged");
        let enabledSkills: string[] = [];
        try {
            await config.update(rolesSection, (current) => {
                const found = component.agentsRuntime().catalog.get(role);
                if (found === undefined) throw new ServiceError("not_found", `There is no role ${role}`);
                const next = change(found.skills);
                enabledSkills = next;
                if (isDeepStrictEqual(next, found.skills)) throw unchanged;
                return withRoleSkills(current, role, next);
            });
        } catch (error) {
            if (error !== unchanged) {
                if (error instanceof ConfigChangeRefused)
                    throw new ServiceError(refusalCodes[error.kind], error.message);
                if (error instanceof RoleRefusedError) throw new ServiceError("invalid_input", error.message);
                throw error;
            }
        }
        return { enabledSkills };
    };

    const readTargetCatalog = (ctx: ServiceContext, target: Target) =>
        readCatalog({
            dataDir: component.dataDir(),
            shippedRoot: component.shippedRoot,
            searchPaths: ctx.config.current(skillsSection).paths,
            workspace: target.workspace,
        });

    /** Changes the enabled set of one seated conversation, after checking the name against the agent's catalog. */
    const changeConversationSkills = async (
        ctx: ServiceContext,
        conversation: string,
        { name, enable }: { name: string; enable: boolean },
        caller: Caller,
    ): Promise<{ enabledSkills: string[] }> => {
        const target = await conversationTarget(ctx, conversation);
        const held = (await readTargetCatalog(ctx, target)).skills.find((skill) => skill.name === name);
        if (enable && held === undefined) {
            throw new ServiceError("not_found", `The catalog of conversation ${conversation} holds no skill ${name}`);
        }
        if (!enable && held?.source.kind === "workspace") {
            throw new ServiceError(
                "invalid_input",
                `The workspace of conversation ${conversation} supplies skill ${name}, which stays enabled`,
            );
        }
        const callerRole =
            caller.actor.kind === "agent"
                ? (await readConversationMeta(ctx.host, caller.actor.conversationId))?.seat.role
                : undefined;
        const defaultsOf = (role: string): string[] => [...(component.agentsRuntime().catalog.get(role)?.skills ?? [])];
        try {
            const enabledSkills = await setEnabledSkill(
                ctx.host,
                conversation,
                { name, enable, actor: seatActorFor(caller, callerRole) },
                defaultsOf,
            );
            return { enabledSkills };
        } catch (error) {
            if (error instanceof ConversationClosedError) throw new ServiceError("conflict", error.message);
            throw error;
        }
    };

    const enableOperation = defineOperation<ServiceContext, ChangeInput, { enabledSkills: string[] }>({
        name: "skills.enable",
        kind: "control",
        parse: parseChange,
        async run(ctx, input, caller) {
            const { name } = input;
            if ("conversation" in input) {
                return changeConversationSkills(ctx, input.conversation, { name, enable: true }, caller);
            }
            const { role } = input;
            const catalog = await readTargetCatalog(ctx, roleTarget(role));
            if (!catalog.skills.some((skill) => skill.name === name)) {
                throw new ServiceError("not_found", `The catalog of role ${role} holds no skill ${name}`);
            }
            return changeRoleSkills(ctx, role, (skills) => (skills.includes(name) ? [...skills] : [...skills, name]));
        },
    });

    const disableOperation = defineOperation<ServiceContext, ChangeInput, { enabledSkills: string[] }>({
        name: "skills.disable",
        kind: "control",
        parse: parseChange,
        async run(ctx, input, caller) {
            const { name } = input;
            if ("conversation" in input) {
                return changeConversationSkills(ctx, input.conversation, { name, enable: false }, caller);
            }
            const { role } = input;
            roleTarget(role);
            return changeRoleSkills(ctx, role, (skills) => skills.filter((skill) => skill !== name));
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [listOperation, enableOperation, disableOperation];
    return operations;
}
