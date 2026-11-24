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
import { watchInstance } from "../host/host_observation.ts";
import { ConversationClosedError, inOpenConversation, isConversationClosed } from "../host/job_section.ts";
import { releaseWaiting } from "../host/model_wait.ts";
import { startReportDelivery } from "../host/reports.ts";
import { changeSeat, readConversationMeta } from "../host/seating.ts";
import { createRolePromptExtension } from "../prompt/role_prompt_extension.ts";
import { createRoleCatalog, type RoleCatalog } from "../roles/role_catalog.ts";
import { rolesSection, workspacesSection } from "../roles/roles_section.ts";
import { SHIPPED_ROLES } from "../roles/shipped_roles.ts";
import type { Operation } from "../service/operations.ts";
import { roleOperations } from "../service/role_operations.ts";
import { seatOperations } from "../service/seat_operations.ts";
import { workspaceOperations } from "../service/workspace_operations.ts";
import { roleInstructionPath } from "../skills/internal_folder.ts";
import { createDiagnosticLog } from "../skills/skill_discovery.ts";
import { createSkillsComponent, type SkillsComponent } from "../skills/skills_component.ts";
import { skillsSection } from "../skills/skills_section.ts";
import { createShippedToolsExtension } from "../tools/shipped_tools_extension.ts";
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
    /**
     * Gives every open conversation with no model pi agent's default model, by an ordinary seat write, then releases the
     * waiting ones one at a time in the order they began to wait (ADR-014 decision 5). The model runtime calls it when
     * the default appears.
     */
    takeUpDefaultModel(): Promise<void>;
};

const DAEMON_ACTOR = { kind: "daemon" } as const;

export async function createAgentsComponent(options: {
    logger: Logger;
    skills?: SkillsComponent;
}): Promise<AgentsComponent> {
    const skills = options.skills ?? createSkillsComponent({ logger: options.logger });
    const diagnostics = createDiagnosticLog(options.logger);
    let searchPaths: () => readonly string[] = () => [];
    let runtime: AgentsRuntime | undefined;
    let host: HarnessHost | undefined;
    let reportDelivery: { stop(): void } | undefined;
    let service: ServiceContext | undefined;
    let removeDefaultListener: (() => void) | undefined;
    let takeUps: Promise<void> = Promise.resolve();

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

    // Seats the default in one open conversation that still has no model; true when it did, and it waits for a model.
    const seatDefault = async (ctx: ServiceContext, conversationId: string): Promise<boolean> => {
        const defaults = ctx.models.defaultChoice();
        if (defaults === undefined) return false;
        try {
            return await inOpenConversation(ctx.host, conversationId, async () => {
                const meta = await readConversationMeta(ctx.host, conversationId);
                if (meta === undefined || meta.seat.model !== null) return false;
                const { seat } = meta;
                const thinkingLevel = seat.thinkingLevel ?? defaults.thinkingLevel;
                // The enabled set resets to the role's defaults, as on any seat write (S-008 REQ-006).
                const skills = requireRuntime().catalog.get(seat.role)?.skills ?? [];
                await changeSeat(ctx.host, conversationId, {
                    seat: {
                        ...seat,
                        model: defaults.model,
                        ...(thinkingLevel !== undefined && { thinkingLevel }),
                        skills,
                    },
                    actor: DAEMON_ACTOR,
                });
                return meta.waitingForModel !== undefined;
            });
        } catch (error) {
            if (error instanceof ConversationClosedError) return false;
            throw error;
        }
    };

    // Resolves once the conversation's run is listed by the admission as active or waiting, or has ended.
    const startsRelease = async (ctx: ServiceContext, conversationId: string): Promise<() => Promise<void>> => {
        const started = Promise.withResolvers<void>();
        const isListed = (): boolean => {
            const { active, waiting } = ctx.admission.state();
            return active.includes(conversationId) || waiting.some((entry) => entry.conversationId === conversationId);
        };
        const removeChange = ctx.admission.onChange(() => isListed() && started.resolve());
        const watch = await watchInstance(ctx.host, (event) => {
            if (event.type === "run_finished" && event.conversationId === conversationId) started.resolve();
        });
        return async () => {
            try {
                await releaseWaiting(ctx.host, conversationId);
                const info = await ctx.host.conversationInfo(conversationId);
                if (isListed() || info?.busy === false) started.resolve();
                await started.promise;
            } finally {
                removeChange();
                watch.stop();
            }
        };
    };

    // The open conversations with no model: the waiting ones in `order` first, then the rest in listing order.
    const listWithNoModel = async (ctx: ServiceContext): Promise<string[]> => {
        const waiting: { id: string; order: number }[] = [];
        const others: string[] = [];
        for (const { id } of await ctx.host.listConversations()) {
            const meta = await readConversationMeta(ctx.host, id);
            if (meta?.seat.model !== null || (await isConversationClosed(ctx.host, id))) continue;
            if (meta.waitingForModel === undefined) others.push(id);
            else waiting.push({ id, order: Number(meta.waitingForModel.order) });
        }
        waiting.sort((a, b) => a.order - b.order);
        return [...waiting.map(({ id }) => id), ...others];
    };

    const takeUp = async (ctx: ServiceContext): Promise<void> => {
        const seatedAndWaiting: string[] = [];
        for (const id of await listWithNoModel(ctx)) {
            if (await seatDefault(ctx, id)) seatedAndWaiting.push(id);
        }
        for (const id of seatedAndWaiting) await (await startsRelease(ctx, id))();
    };

    const component: DaemonComponent = {
        name: "agents",
        extensions: [
            ...(skills.component.extensions ?? []),
            createRolePromptExtension({
                dataDir: skills.dataDir,
                searchPaths: () => searchPaths(),
                defaultsOf: (role) => new Set(requireRuntime().catalog.get(role)?.skills ?? []),
                diagnostics,
                shippedRoot: skills.shippedRoot,
            }),
            createShippedToolsExtension({ runtimeDir: () => skills.runtimeDir() }),
            createCoordinationExtension({ host: requireHost, runtime: requireRuntime }),
        ],
        async prepareFiles(input) {
            return skills.component.prepareFiles?.(input);
        },
        async checkModels(ctx) {
            await skills.component.checkModels?.(ctx);
            host = ctx.host;
            searchPaths = () => ctx.config.current(skillsSection).paths;
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
            service = ctx;
            removeDefaultListener = ctx.models.onDefaultAppeared(() => {
                agents.takeUpDefaultModel().catch((error) =>
                    options.logger.error("taking up the default model failed", {
                        cause: error instanceof Error ? error.message : String(error),
                    }),
                );
            });
        },
        async stop() {
            removeDefaultListener?.();
            removeDefaultListener = undefined;
            service = undefined;
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
        takeUpDefaultModel() {
            const ctx = service;
            if (ctx === undefined) return Promise.reject(new Error("The agents component has not started"));
            // One take-up at a time: a later call waits for the one running.
            takeUps = takeUps.then(() => takeUp(ctx));
            const result = takeUps;
            takeUps = takeUps.catch(() => undefined);
            return result;
        },
    };
    skills.connectAgents(requireRuntime);
    agents.operations.push(...roleOperations(agents), ...workspaceOperations(agents), ...seatOperations(agents));
    return agents;
}
