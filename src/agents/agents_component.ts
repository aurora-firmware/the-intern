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
import { createRolePromptExtension } from "../prompt/role_prompt_extension.ts";
import { createWorkspaceContextLoader } from "../prompt/workspace_context.ts";
import { createRoleCatalog, type RoleCatalog } from "../roles/role_catalog.ts";
import { rolesSection, workspacesSection } from "../roles/roles_section.ts";
import { loadPreamble, loadShippedRoles } from "../roles/shipped_roles.ts";
import { jobOperations } from "../service/job_operations.ts";
import type { Operation } from "../service/operations.ts";
import { roleOperations } from "../service/role_operations.ts";
import { seatOperations } from "../service/seat_operations.ts";
import { workspaceOperations } from "../service/workspace_operations.ts";
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
};

export async function createAgentsComponent(options: { logger: Logger }): Promise<AgentsComponent> {
    const shipped = await loadShippedRoles();
    const preamble = await loadPreamble();
    const loader = createWorkspaceContextLoader({ logger: options.logger });
    let runtime: AgentsRuntime | undefined;
    let host: HarnessHost | undefined;

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
        const catalog = createRoleCatalog({ config: ctx.config, shipped, workspaces, models: ctx.models, dataDir });
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
            createRolePromptExtension({ preamble, loader }),
            shippedToolsExtension,
            createCoordinationExtension({ host: requireHost, runtime: requireRuntime }),
        ],
        async checkModels(ctx) {
            host = ctx.host;
            runtime = buildRuntime(ctx);
            runtime.catalog.checkConfigured();
        },
        async ensureWorkspaces(ctx) {
            const { catalog, workspaces } = requireRuntime();
            await workspaces.checkConfigured();
            for (const role of catalog.list()) {
                if (role.workspace === undefined) await workspaces.ensureRoleDefault(role.name);
            }
            checkRoleWorkspacesRegistered({ catalog, workspaces }, ctx.dirs.dataDir);
        },
    };

    const agents: AgentsComponent = {
        component,
        sections: [rolesSection, workspacesSection],
        operations: [],
        runtime: requireRuntime,
    };
    agents.operations.push(
        ...roleOperations(agents),
        ...workspaceOperations(agents),
        ...seatOperations(agents),
        ...jobOperations(agents),
    );
    return agents;
}
