/**
 * S-001's parts as one daemon component: the roles and workspaces configuration sections, the role prompt and shipped
 * tools extensions, the startup checks of step 5 (every configured model and thinking level resolves) and step 6 (the
 * workspaces are usable and every role has a registered default workspace).
 */
import type { ConfigSection } from "../config/config_file.ts";
import { createCoordinationExtension } from "../coordination/coordination_extension.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { startReportDelivery } from "../host/reports.ts";
import { createRolePromptExtension } from "../prompt/role_prompt_extension.ts";
import { createWorkspaceContextLoader } from "../prompt/workspace_context.ts";
import { createRoleCatalog, type RoleCatalog } from "../roles/role_catalog.ts";
import { rolesSection, workspacesSection } from "../roles/roles_section.ts";
import { loadPreamble, SHIPPED_ROLES } from "../roles/shipped_roles.ts";
import type { Operation } from "../service/operations.ts";
import { roleOperations } from "../service/role_operations.ts";
import { seatOperations } from "../service/seat_operations.ts";
import { workspaceOperations } from "../service/workspace_operations.ts";
import { roleInstructionPath } from "../skills/internal_folder.ts";
import { createSkillsComponent, type SkillsComponent } from "../skills/skills_component.ts";
import { shippedToolsExtension } from "../tools/shipped_tools_extension.ts";
import { roleWorkspacePath } from "../workspaces/workspace_folder.ts";
import {
    createWorkspaceRegistry,
    WorkspaceRefusedError,
    type WorkspaceRegistry,
} from "../workspaces/workspace_registry.ts";

export type AgentsRuntime = { catalog: RoleCatalog; workspaces: WorkspaceRegistry };

export type AgentsComponent = {
    component: DaemonComponent;
    sections: readonly ConfigSection<unknown>[];
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
    runtime(): AgentsRuntime;
    skills: SkillsComponent;
};

export async function createAgentsComponent(options: {
    logger: Logger;
    skills?: SkillsComponent;
}): Promise<AgentsComponent> {
    const skills = options.skills ?? createSkillsComponent({ logger: options.logger });
    const preamble = await loadPreamble();
    const loader = createWorkspaceContextLoader({ logger: options.logger });
    let runtime: AgentsRuntime | undefined;
    let host: HarnessHost | undefined;
    let reportDelivery: { stop(): void } | undefined;

    const requireRuntime = (): AgentsRuntime => {
        if (runtime === undefined) {
            throw new Error("The agents runtime exists only after startup step 5 (check models) has run");
        }
        return runtime;
    };

    const requireHost = (): HarnessHost => {
        if (host === undefined) throw new Error("The harness host exists only after startup step 4 (open the host)");
        return host;
    };

    const buildRuntime = (ctx: ServiceContext): AgentsRuntime => {
        const dataDir = ctx.dirs.dataDir;
        // The registry and the catalog refer to each other, so the registry asks the catalog once it exists.
        const catalogRef: { current?: RoleCatalog } = {};
        const workspaces = createWorkspaceRegistry({
            config: ctx.config,
            dataDir,
            account: { uid: process.getuid?.() ?? 0 },
            defaultWorkspaceUsers: (path) => catalogRef.current?.defaultWorkspaceUsers(path) ?? [],
        });
        const catalog = createRoleCatalog({
            config: ctx.config,
            shipped: SHIPPED_ROLES,
            workspaces,
            models: ctx.models,
            dataDir,
            instructionPath: (role) => roleInstructionPath(dataDir, role),
            fileStore: skills.fileStore,
            shippedRoot: skills.shippedRoot,
        });
        catalogRef.current = catalog;
        return { catalog, workspaces };
    };

    const checkRoleWorkspacesRegistered = ({ catalog, workspaces }: AgentsRuntime, dataDir: string): void => {
        for (const role of catalog.list()) {
            const path = role.workspace ?? roleWorkspacePath(dataDir, role.name);
            if (!workspaces.isRegistered(path)) {
                throw new WorkspaceRefusedError(path, `the workspace of the role ${role.name} is not registered`);
            }
        }
    };

    const component: DaemonComponent = {
        name: "agents",
        extensions: [
            ...(skills.component.extensions ?? []),
            createRolePromptExtension({ preamble, loader }),
            shippedToolsExtension,
            createCoordinationExtension({ host: requireHost, runtime: requireRuntime }),
        ],
        async prepareFiles(input) {
            return skills.component.prepareFiles?.(input);
        },
        async checkModels(ctx) {
            await skills.component.checkModels?.(ctx);
            host = ctx.host;
            runtime = buildRuntime(ctx);
            runtime.catalog.checkConfigured();
        },
        async ensureWorkspaces(ctx) {
            await skills.component.ensureWorkspaces?.(ctx);
            const { catalog, workspaces } = requireRuntime();
            await workspaces.checkConfigured();
            for (const role of catalog.list()) {
                if (role.workspace === undefined) await workspaces.ensureRoleDefault(role.name);
            }
            checkRoleWorkspacesRegistered({ catalog, workspaces }, ctx.dirs.dataDir);
        },
        async repair(ctx) {
            await skills.component.repair?.(ctx);
        },
        async afterResume(ctx) {
            await skills.component.afterResume?.(ctx);
        },
        async start(ctx) {
            await skills.component.start?.(ctx);
            reportDelivery = await startReportDelivery(ctx.host, { logger: options.logger });
        },
        async stop() {
            reportDelivery?.stop();
            reportDelivery = undefined;
            await skills.component.stop?.();
        },
    };

    const agents: AgentsComponent = {
        component,
        sections: [...skills.sections, rolesSection, workspacesSection],
        operations: [...skills.operations],
        runtime: requireRuntime,
        skills,
    };
    skills.connectAgents(requireRuntime);
    agents.operations.push(...roleOperations(agents), ...workspaceOperations(agents), ...seatOperations(agents));
    return agents;
}
