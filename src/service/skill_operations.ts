/**
 * The skills operations (S-008 REQ-009): `skills.list` reads the catalog a role or a seated agent sees, with each
 * skill's source, whether it is enabled, the copies it shadows, and the skills left out. It returns no file text.
 */
import type { ServiceContext } from "../daemon/daemon.ts";
import { readConversationMeta } from "../host/seating.ts";
import type { Seat } from "../roles/role_model.ts";
import { readCatalog } from "../skills/skill_discovery.ts";
import { type CatalogSkill, enabledSkillsOf, type SkillSource } from "../skills/skill_resolution.ts";
import type { SkillsComponent } from "../skills/skills_component.ts";
import { skillsSection } from "../skills/skills_section.ts";
import { roleWorkspacePath } from "../workspaces/workspace_folder.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type ListInput = { role: string } | { conversation: string };

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

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [listOperation];
    return operations;
}
