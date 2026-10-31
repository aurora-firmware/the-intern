import type { ConfigStore } from "../config/config_writer.ts";
import { workspacesSection } from "../roles/roles_section.ts";
import { checkWorkspaceFolder, ensureRoleWorkspace } from "./workspace_folder.ts";

export type WorkspaceListing = { path: string; kind: "registered" | "role_default"; role?: string };

export type WorkspaceRegistry = {
    list(): WorkspaceListing[];
    isRegistered(path: string): boolean;
    register(path: string): Promise<void>;
    unregister(path: string): Promise<void>;
    ensureRoleDefault(role: string): Promise<string>;
    checkConfigured(): Promise<void>;
};

export type WorkspaceRegistryOptions = {
    config: ConfigStore;
    dataDir: string;
    account: { uid: number };
    defaultWorkspaceUsers(path: string): string[];
};

export class WorkspaceRefusedError extends Error {
    path: string;
    reason: string;

    constructor(path: string, reason: string) {
        super(`Workspace ${path}: ${reason}`);
        this.name = "WorkspaceRefusedError";
        this.path = path;
        this.reason = reason;
    }
}

export function createWorkspaceRegistry(options: WorkspaceRegistryOptions): WorkspaceRegistry {
    const { config, dataDir, account, defaultWorkspaceUsers } = options;
    // Per-role default workspaces are never written to the file, so they are tracked here, path to role.
    const roleDefaults = new Map<string, string>();

    const registered = (): string[] => config.current(workspacesSection).registered;
    const isRegistered = (path: string): boolean => registered().includes(path) || roleDefaults.has(path);

    return {
        list() {
            const listings: WorkspaceListing[] = registered().map((path) => ({ path, kind: "registered" }));
            for (const [path, role] of roleDefaults) listings.push({ path, kind: "role_default", role });
            return listings;
        },
        isRegistered,
        async register(path) {
            if (registered().includes(path)) return;
            await checkWorkspaceFolder(path, account);
            await config.change(workspacesSection, { registered: [...registered(), path] });
        },
        async unregister(path) {
            const defaultRole = roleDefaults.get(path);
            if (defaultRole !== undefined) {
                throw new WorkspaceRefusedError(path, `it is the default workspace of the ${defaultRole} role`);
            }
            const users = defaultWorkspaceUsers(path);
            if (users.length > 0) {
                throw new WorkspaceRefusedError(path, `it is the default workspace of the roles ${users.join(", ")}`);
            }
            if (!registered().includes(path)) return;
            await config.change(workspacesSection, { registered: registered().filter((entry) => entry !== path) });
        },
        async ensureRoleDefault(role) {
            const path = await ensureRoleWorkspace(dataDir, role, account);
            roleDefaults.set(path, role);
            return path;
        },
        async checkConfigured() {
            for (const path of registered()) await checkWorkspaceFolder(path, account);
        },
    };
}
