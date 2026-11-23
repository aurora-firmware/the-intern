import { chmod, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const OWNER_ONLY_MODE = 0o700;
const GROUP_AND_OTHER_BITS = 0o077;
const WORKSPACES_FOLDER_NAME = "workspaces";

export class WorkspaceFolderError extends Error {
    path: string;
    reason: string;

    constructor(path: string, reason: string) {
        super(`Workspace folder ${path}: ${reason}`);
        this.name = "WorkspaceFolderError";
        this.path = path;
        this.reason = reason;
    }
}

/** Resolves when the path may be registered as a workspace; otherwise throws a WorkspaceFolderError. */
export async function checkWorkspaceFolder(path: string, account: { uid: number }): Promise<void> {
    if (!isAbsolute(path)) throw new WorkspaceFolderError(path, "not absolute");
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceFolderError(path, "does not exist");
        throw error;
    }
    if (!info.isDirectory()) throw new WorkspaceFolderError(path, "not a directory");
    if (info.uid !== account.uid) throw new WorkspaceFolderError(path, "not owned by the service account");
    if ((info.mode & GROUP_AND_OTHER_BITS) !== 0) {
        throw new WorkspaceFolderError(path, "accessible to the group or others");
    }
}

export function roleWorkspacePath(dataDir: string, role: string): string {
    return join(dataDir, WORKSPACES_FOLDER_NAME, role);
}

/**
 * Returns the role's default workspace, creating it owner-only when missing. An existing folder is checked and
 * refused when unsafe, never chmod-ed.
 */
export async function ensureRoleWorkspace(dataDir: string, role: string, account: { uid: number }): Promise<string> {
    const path = roleWorkspacePath(dataDir, role);
    for (const folder of [join(dataDir, WORKSPACES_FOLDER_NAME), path]) {
        try {
            await mkdir(folder, { mode: OWNER_ONLY_MODE });
            await chmod(folder, OWNER_ONLY_MODE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    await checkWorkspaceFolder(path, account);
    return path;
}
