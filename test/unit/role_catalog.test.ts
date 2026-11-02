import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config/config_file.ts";
import { createConfigStore } from "../../src/config/config_writer.ts";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import type { ModelChoice } from "../../src/models/model_runtime.ts";
import { createRoleCatalog, type RoleCatalog, RoleRefusedError } from "../../src/roles/role_catalog.ts";
import type { RoleDefinition } from "../../src/roles/role_model.ts";
import { rolesSection, workspacesSection } from "../../src/roles/roles_section.ts";
import { createWorkspaceRegistry } from "../../src/workspaces/workspace_registry.ts";

const SHIPPED: RoleDefinition[] = [
    { name: "bob", instructions: "Lead the team.", tools: ["read", "bash"], skills: [] },
    { name: "gp", instructions: "Carry out a part.", tools: ["read"], skills: ["/shipped/skills/part"] },
];
const KNOWN_LEVELS = ["low", "high"];

const teamRole = (overrides: Partial<RoleDefinition> = {}): RoleDefinition => ({
    name: "reviewer",
    instructions: "Review the work.",
    tools: ["read"],
    skills: [],
    ...overrides,
});

describe("createRoleCatalog", () => {
    let root: string;
    let file: string;
    let dataDir: string;
    let registeredFolder: string;
    let catalog: RoleCatalog;
    let referrers: Record<string, string[]>;
    let initialText: string;
    let defaultChoice: ModelChoice | undefined;

    const fileText = (): Promise<string> => readFile(file, "utf8").catch(() => "");

    const refusal = (action: () => unknown): RoleRefusedError => {
        try {
            action();
        } catch (error) {
            assert.ok(error instanceof RoleRefusedError, `expected RoleRefusedError, got ${String(error)}`);
            return error;
        }
        throw new assert.AssertionError({ message: "expected the call to be refused" });
    };

    const refusalOf = async (action: () => Promise<unknown>): Promise<RoleRefusedError> => {
        try {
            await action();
        } catch (error) {
            assert.ok(error instanceof RoleRefusedError, `expected RoleRefusedError, got ${String(error)}`);
            return error;
        }
        throw new assert.AssertionError({ message: "expected the call to be refused" });
    };

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "role-catalog-"));
        file = join(root, "config.toml");
        dataDir = join(root, "data");
        registeredFolder = join(root, "project");
        await mkdir(dataDir, { mode: 0o700 });
        await mkdir(registeredFolder, { mode: 0o700 });
        referrers = {};
        defaultChoice = { model: "p/default", thinkingLevel: "medium" };
        const sections = [rolesSection, workspacesSection];
        const config = createConfigStore(file, sections, await loadConfig(file, sections));
        const account = { uid: process.getuid?.() ?? 0 };
        // The registry asks the catalog for default-workspace users, so the catalog is bound after both exist.
        const workspaces = createWorkspaceRegistry({
            config,
            dataDir,
            account,
            defaultWorkspaceUsers: (path) => catalog.defaultWorkspaceUsers(path),
        });
        await workspaces.register(registeredFolder);
        catalog = createRoleCatalog({
            config,
            shipped: SHIPPED,
            workspaces,
            dataDir,
            models: {
                checkModelChoice: (choice) => {
                    if (choice.model !== "p/m" && choice.model !== "p/default") {
                        return { ok: false, reason: `unknown model ${choice.model}` };
                    }
                    const levels = [...KNOWN_LEVELS, "medium"];
                    if (choice.thinkingLevel !== undefined && !levels.includes(choice.thinkingLevel)) {
                        return { ok: false, reason: `unsupported level ${choice.thinkingLevel}` };
                    }
                    return { ok: true };
                },
                defaultChoice: () => defaultChoice,
            },
        });
        initialText = await fileText();
        catalog.addReferenceSource({ name: "schedules", referrersOf: (role) => referrers[role] ?? [] });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("lists the shipped roles as unchanged before any change", () => {
        assert.deepEqual(
            catalog.list().map((role) => [role.name, role.shipped, role.changed]),
            [
                ["bob", true, false],
                ["gp", true, false],
            ],
        );
        assert.equal(catalog.get("nobody"), undefined);
    });

    it("writes a created, changed and removed team role to the configuration file and lists it accordingly", async () => {
        await catalog.create(teamRole({ model: "p/m", workspace: registeredFolder }));
        assert.match(await fileText(), /\[roles\.reviewer\]/);
        assert.deepEqual(catalog.get("reviewer"), {
            ...teamRole({ model: "p/m", workspace: registeredFolder }),
            shipped: false,
            changed: false,
        });

        await catalog.change("reviewer", { instructions: "Review harder.", thinkingLevel: "high" });
        assert.match(await fileText(), /Review harder\./);
        assert.equal(catalog.get("reviewer")?.thinkingLevel, "high");
        assert.equal(catalog.get("reviewer")?.model, "p/m");

        await catalog.remove("reviewer");
        assert.doesNotMatch(await fileText(), /reviewer/);
        assert.equal(catalog.get("reviewer"), undefined);
    });

    it("gives a created role without a workspace its per-role default workspace", async () => {
        await catalog.create(teamRole());
        const seat = catalog.seatFor("reviewer");
        assert.equal(seat.workspace, join(dataDir, "workspaces", "reviewer"));
        assert.doesNotMatch(await fileText(), /workspace =/);
    });

    it("lists a changed shipped role with the new values and then with the shipped values after a restore", async () => {
        await catalog.change("gp", { instructions: "Carry out a part, slowly.", model: "p/m" });
        assert.deepEqual(
            [catalog.get("gp")?.changed, catalog.get("gp")?.shipped, catalog.get("gp")?.instructions],
            [true, true, "Carry out a part, slowly."],
        );
        assert.equal(catalog.get("gp")?.model, "p/m");
        assert.match(await fileText(), /\[roles\.gp\]/);

        await catalog.restore("gp");
        assert.deepEqual({ ...catalog.get("gp") }, { ...SHIPPED[1], shipped: true, changed: false });
        assert.doesNotMatch(await fileText(), /gp/);
    });

    it("accumulates successive changes to a shipped role until it is restored", async () => {
        await catalog.change("bob", { model: "p/m" });
        await catalog.change("bob", { thinkingLevel: "low" });
        assert.equal(catalog.get("bob")?.model, "p/m");
        assert.equal(catalog.get("bob")?.thinkingLevel, "low");
    });

    it("refuses to remove a shipped role and leaves the file unchanged", async () => {
        const before = await fileText();
        const error = await refusalOf(() => catalog.remove("bob"));
        assert.equal(error.kind, "conflict");
        assert.equal(error.role, "bob");
        assert.equal(await fileText(), before);
        assert.ok(catalog.get("bob"));
    });

    it("refuses to remove a role a reference source names, naming the referrers", async () => {
        await catalog.create(teamRole());
        referrers.reviewer = ["schedule nightly", "trigger on-push"];
        const before = await fileText();
        const error = await refusalOf(() => catalog.remove("reviewer"));
        assert.equal(error.kind, "conflict");
        assert.match(error.message, /schedule nightly/);
        assert.match(error.message, /trigger on-push/);
        assert.equal(await fileText(), before);
        assert.ok(catalog.get("reviewer"));
    });

    it("refuses removing, changing or restoring an unknown role as not found", async () => {
        assert.equal((await refusalOf(() => catalog.remove("nobody"))).kind, "not_found");
        assert.equal((await refusalOf(() => catalog.change("nobody", {}))).kind, "not_found");
        assert.equal((await refusalOf(() => catalog.restore("nobody"))).kind, "not_found");
        assert.equal(refusal(() => catalog.seatFor("nobody")).kind, "not_found");
    });

    it("refuses to create a role whose name is taken, including a shipped name", async () => {
        await catalog.create(teamRole());
        assert.equal((await refusalOf(() => catalog.create(teamRole()))).kind, "conflict");
        assert.equal((await refusalOf(() => catalog.create(teamRole({ name: "bob" })))).kind, "conflict");
    });

    it("refuses a create or change that names an unknown tool, naming the role, field and value", async () => {
        const created = await refusalOf(() => catalog.create(teamRole({ tools: ["read", "teleport"] })));
        assert.deepEqual(
            [created.kind, created.role, created.field, created.value],
            ["invalid", "reviewer", "tools", "teleport"],
        );
        const changed = await refusalOf(() => catalog.change("gp", { tools: ["teleport"] }));
        assert.deepEqual([changed.role, changed.field, changed.value], ["gp", "tools", "teleport"]);
        assert.equal(await fileText(), initialText);
        assert.equal(catalog.get("reviewer"), undefined);
        assert.equal(catalog.get("gp")?.changed, false);
    });

    it("accepts a create that names a job tool", async () => {
        await catalog.create(teamRole({ tools: ["read", ...JOB_TOOL_NAMES] }));
        assert.deepEqual(catalog.get("reviewer")?.tools, ["read", ...JOB_TOOL_NAMES]);
    });

    it("refuses a create or change that names a model or thinking level the model check refuses", async () => {
        const model = await refusalOf(() => catalog.create(teamRole({ model: "p/missing" })));
        assert.deepEqual(
            [model.kind, model.role, model.field, model.value],
            ["invalid", "reviewer", "model", "p/missing"],
        );
        const level = await refusalOf(() => catalog.change("gp", { model: "p/m", thinkingLevel: "extreme" }));
        assert.deepEqual([level.role, level.field, level.value], ["gp", "thinkingLevel", "extreme"]);
        assert.equal(await fileText(), initialText);
        assert.equal(catalog.get("gp")?.changed, false);
    });

    it("refuses a create or change that names an unregistered workspace", async () => {
        const unregistered = join(root, "elsewhere");
        const created = await refusalOf(() => catalog.create(teamRole({ workspace: unregistered })));
        assert.deepEqual(
            [created.kind, created.role, created.field, created.value],
            ["invalid", "reviewer", "workspace", unregistered],
        );
        const changed = await refusalOf(() => catalog.change("bob", { workspace: unregistered }));
        assert.deepEqual([changed.role, changed.field, changed.value], ["bob", "workspace", unregistered]);
        assert.equal(await fileText(), initialText);
    });

    it("refuses a seatFor override that names a model, thinking level or workspace the checks refuse", async () => {
        const model = refusal(() => catalog.seatFor("bob", { model: "p/missing" }));
        assert.deepEqual([model.role, model.field, model.value], ["bob", "model", "p/missing"]);
        const level = refusal(() => catalog.seatFor("bob", { model: "p/m", thinkingLevel: "extreme" }));
        assert.deepEqual([level.field, level.value], ["thinkingLevel", "extreme"]);
        const workspace = refusal(() => catalog.seatFor("bob", { workspace: join(root, "elsewhere") }));
        assert.deepEqual([workspace.field, workspace.value], ["workspace", join(root, "elsewhere")]);
    });

    it("refuses a seatFor when no model can be resolved", () => {
        defaultChoice = undefined;
        const error = refusal(() => catalog.seatFor("bob"));
        assert.deepEqual([error.kind, error.field], ["invalid", "model"]);
    });

    it("seats a role without defaults on pi agent's default model, thinking level and its per-role default workspace", async () => {
        await catalog.create(teamRole());
        const seat = catalog.seatFor("gp");
        assert.equal(seat.model, "p/default");
        assert.equal(seat.thinkingLevel, "medium");
        assert.equal(seat.workspace, join(dataDir, "workspaces", "gp"));
        assert.equal(seat.role, "gp");
    });

    it("seats a role with its own defaults and the overrides over them", async () => {
        await catalog.create(teamRole({ model: "p/m", thinkingLevel: "low", workspace: registeredFolder }));
        assert.deepEqual(
            [
                catalog.seatFor("reviewer").model,
                catalog.seatFor("reviewer").thinkingLevel,
                catalog.seatFor("reviewer").workspace,
            ],
            ["p/m", "low", registeredFolder],
        );
        assert.equal(catalog.seatFor("reviewer", { thinkingLevel: "high" }).thinkingLevel, "high");
    });

    it("leaves a seat already resolved unchanged by a later role change", async () => {
        const before = catalog.seatFor("gp");
        await catalog.change("gp", { instructions: "Different." });
        assert.equal(before.instructions, SHIPPED[1]?.instructions);
        assert.equal(catalog.seatFor("gp").instructions, "Different.");
    });

    it("names the roles whose own workspace is a path, so the registry refuses to unregister it", async () => {
        await catalog.create(teamRole({ workspace: registeredFolder }));
        await catalog.change("bob", { workspace: registeredFolder });
        assert.deepEqual(catalog.defaultWorkspaceUsers(registeredFolder).sort(), ["bob", "reviewer"]);
        assert.deepEqual(catalog.defaultWorkspaceUsers(join(root, "other")), []);
    });

    it("refuses a configured role whose model or thinking level the model check refuses at startup", async () => {
        catalog.checkConfigured();
        await catalog.create(teamRole({ model: "p/m", thinkingLevel: "low" }));
        catalog.checkConfigured();
        defaultChoice = undefined;
        const strict = createRoleCatalog({
            config: createConfigStore(
                file,
                [rolesSection, workspacesSection],
                await loadConfig(file, [rolesSection, workspacesSection]),
            ),
            shipped: SHIPPED,
            workspaces: { isRegistered: () => true } as never,
            dataDir,
            models: { checkModelChoice: () => ({ ok: false, reason: "gone" }), defaultChoice: () => undefined },
        });
        const error = refusal(() => strict.checkConfigured());
        assert.deepEqual([error.kind, error.role, error.field, error.value], ["invalid", "reviewer", "model", "p/m"]);
    });
});
