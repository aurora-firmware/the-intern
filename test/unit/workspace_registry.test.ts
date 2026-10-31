import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config/config_file.ts";
import { createConfigStore } from "../../src/config/config_writer.ts";
import { workspacesSection } from "../../src/roles/roles_section.ts";
import { WorkspaceFolderError } from "../../src/workspaces/workspace_folder.ts";
import { createWorkspaceRegistry, WorkspaceRefusedError } from "../../src/workspaces/workspace_registry.ts";

describe("createWorkspaceRegistry", () => {
    let root: string;
    let file: string;
    let dataDir: string;
    let roleUsers: Record<string, string[]>;
    const account = { uid: process.getuid?.() ?? 0 };

    const makeRegistry = async () => {
        const loaded = await loadConfig(file, [workspacesSection]);
        const config = createConfigStore(file, [workspacesSection], loaded);
        return createWorkspaceRegistry({
            config,
            dataDir,
            account,
            defaultWorkspaceUsers: (path) => roleUsers[path] ?? [],
        });
    };

    const makeFolder = async (name: string, mode = 0o700): Promise<string> => {
        const path = join(root, name);
        await mkdir(path);
        await chmod(path, mode);
        return path;
    };

    const fileText = async (): Promise<string> => readFile(file, "utf8").catch(() => "");

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "workspace-registry-"));
        file = join(root, "config.toml");
        dataDir = join(root, "data");
        await mkdir(dataDir, { mode: 0o700 });
        roleUsers = {};
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("writes a valid folder to the file and reports it registered", async () => {
        const registry = await makeRegistry();
        const folder = await makeFolder("project");
        await registry.register(folder);
        assert.equal(registry.isRegistered(folder), true);
        assert.deepEqual(registry.list(), [{ path: folder, kind: "registered" }]);
        assert.match(await fileText(), new RegExp(folder));
    });

    it("changes nothing when the folder is already registered", async () => {
        const registry = await makeRegistry();
        const folder = await makeFolder("project");
        await registry.register(folder);
        const before = await fileText();
        await registry.register(folder);
        assert.equal(await fileText(), before);
        assert.equal(registry.list().length, 1);
    });

    it("refuses a folder that fails the check and leaves the file unchanged", async () => {
        const registry = await makeRegistry();
        const open = await makeFolder("open", 0o750);
        await assert.rejects(registry.register(open), (error: unknown) => {
            assert.ok(error instanceof WorkspaceFolderError);
            assert.equal(error.path, open);
            return true;
        });
        assert.equal(registry.isRegistered(open), false);
        assert.equal(await fileText(), "");
    });

    it("refuses to unregister a folder that is a role's default workspace, naming the roles", async () => {
        const registry = await makeRegistry();
        const folder = await makeFolder("shared");
        roleUsers[folder] = ["reviewer", "writer"];
        await registry.register(folder);
        const before = await fileText();
        await assert.rejects(registry.unregister(folder), (error: unknown) => {
            assert.ok(error instanceof WorkspaceRefusedError);
            assert.equal(error.path, folder);
            assert.match(error.reason, /reviewer/);
            assert.match(error.reason, /writer/);
            return true;
        });
        assert.equal(registry.isRegistered(folder), true);
        assert.equal(await fileText(), before);
    });

    it("refuses to unregister a per-role default workspace and keeps it out of the file", async () => {
        const registry = await makeRegistry();
        const path = await registry.ensureRoleDefault("planner");
        assert.deepEqual(registry.list(), [{ path, kind: "role_default", role: "planner" }]);
        assert.equal(registry.isRegistered(path), true);
        assert.equal(await fileText(), "");
        await assert.rejects(registry.unregister(path), WorkspaceRefusedError);
        assert.equal(registry.isRegistered(path), true);
    });

    it("removes an unregistered folder from the file and reports it not registered", async () => {
        const registry = await makeRegistry();
        const folder = await makeFolder("project");
        await registry.register(folder);
        await registry.unregister(folder);
        assert.equal(registry.isRegistered(folder), false);
        assert.deepEqual(registry.list(), []);
        assert.doesNotMatch(await fileText(), new RegExp(folder));
    });

    it("throws a folder error naming a registered folder that is now missing", async () => {
        const registry = await makeRegistry();
        const folder = await makeFolder("project");
        await registry.register(folder);
        await rm(folder, { recursive: true });
        await assert.rejects(registry.checkConfigured(), (error: unknown) => {
            assert.ok(error instanceof WorkspaceFolderError);
            assert.equal(error.path, folder);
            return true;
        });
    });

    it("throws a folder error naming a registered folder that became group accessible", async () => {
        const registry = await makeRegistry();
        const folder = await makeFolder("project");
        await registry.register(folder);
        await chmod(folder, 0o770);
        await assert.rejects(registry.checkConfigured(), (error: unknown) => {
            assert.ok(error instanceof WorkspaceFolderError);
            assert.equal(error.path, folder);
            return true;
        });
    });

    it("resolves checkConfigured when every registered folder is safe", async () => {
        const registry = await makeRegistry();
        await registry.register(await makeFolder("project"));
        await registry.checkConfigured();
    });
});
