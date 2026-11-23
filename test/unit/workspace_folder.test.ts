import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    checkWorkspaceFolder,
    ensureRoleWorkspace,
    roleWorkspacePath,
    WorkspaceFolderError,
} from "../../src/workspaces/workspace_folder.ts";

const ACCOUNT = { uid: process.getuid?.() ?? 0 };

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "workspace-folder-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function privateDir(name: string, mode = 0o700): Promise<string> {
    const path = join(root, name);
    await mkdir(path);
    await chmod(path, mode);
    return path;
}

async function reasonOf(promise: Promise<unknown>): Promise<WorkspaceFolderError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof WorkspaceFolderError, `unexpected error: ${error}`);
        return error;
    }
    assert.fail("expected WorkspaceFolderError");
}

describe("checkWorkspaceFolder", () => {
    it("resolves for an absolute owner-only directory owned by the account", async () => {
        await checkWorkspaceFolder(await privateDir("ok"), ACCOUNT);
    });

    it("refuses a relative path", async () => {
        const error = await reasonOf(checkWorkspaceFolder("relative/dir", ACCOUNT));
        assert.equal(error.reason, "not absolute");
        assert.equal(error.path, "relative/dir");
    });

    it("refuses a missing path", async () => {
        const path = join(root, "missing");
        const error = await reasonOf(checkWorkspaceFolder(path, ACCOUNT));
        assert.equal(error.reason, "does not exist");
        assert.equal(error.path, path);
    });

    it("refuses a path that is a file", async () => {
        const path = join(root, "file");
        await writeFile(path, "x");
        const error = await reasonOf(checkWorkspaceFolder(path, ACCOUNT));
        assert.equal(error.reason, "not a directory");
    });

    it("refuses a directory owned by another uid", async () => {
        const error = await reasonOf(checkWorkspaceFolder(await privateDir("other"), { uid: ACCOUNT.uid + 1 }));
        assert.equal(error.reason, "not owned by the service account");
    });

    it("refuses a group-accessible directory", async () => {
        const error = await reasonOf(checkWorkspaceFolder(await privateDir("group", 0o750), ACCOUNT));
        assert.equal(error.reason, "accessible to the group or others");
    });

    it("refuses a world-accessible directory", async () => {
        const error = await reasonOf(checkWorkspaceFolder(await privateDir("world", 0o705), ACCOUNT));
        assert.equal(error.reason, "accessible to the group or others");
    });
});

describe("roleWorkspacePath", () => {
    it("places the role folder under workspaces in the data directory", () => {
        assert.equal(roleWorkspacePath("/data/the-intern", "developer"), "/data/the-intern/workspaces/developer");
    });
});

describe("ensureRoleWorkspace", () => {
    it("creates the workspaces and role folders with mode 0700 and returns the path", async () => {
        const dataDir = await privateDir("data");
        const path = await ensureRoleWorkspace(dataDir, "developer", ACCOUNT);
        assert.equal(path, join(dataDir, "workspaces", "developer"));
        assert.equal((await stat(path)).mode & 0o777, 0o700);
        assert.equal((await stat(join(dataDir, "workspaces"))).mode & 0o777, 0o700);
    });

    it("returns an existing safe role folder unchanged", async () => {
        const dataDir = await privateDir("data");
        const first = await ensureRoleWorkspace(dataDir, "developer", ACCOUNT);
        assert.equal(await ensureRoleWorkspace(dataDir, "developer", ACCOUNT), first);
    });

    it("refuses an existing group-accessible role folder and leaves its mode unchanged", async () => {
        const dataDir = await privateDir("data");
        await mkdir(join(dataDir, "workspaces"), { mode: 0o700 });
        const path = join(dataDir, "workspaces", "developer");
        await mkdir(path);
        await chmod(path, 0o750);
        const error = await reasonOf(ensureRoleWorkspace(dataDir, "developer", ACCOUNT));
        assert.equal(error.reason, "accessible to the group or others");
        assert.equal((await stat(path)).mode & 0o777, 0o750);
    });
});
