import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config/config_file.ts";
import { type ConfigStore, createConfigStore } from "../../src/config/config_writer.ts";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import type { ModelChoice } from "../../src/models/model_runtime.ts";
import { createRoleCatalog, type RoleCatalog, RoleRefusedError } from "../../src/roles/role_catalog.ts";
import type { RoleDefinition } from "../../src/roles/role_model.ts";
import { rolesSection, workspacesSection } from "../../src/roles/roles_section.ts";
import { createFileStore, type FileStore } from "../../src/skills/file_store.ts";
import { prepareInternalFolder, roleInstructionPath } from "../../src/skills/internal_folder.ts";
import { createWorkspaceRegistry } from "../../src/workspaces/workspace_registry.ts";

const SHIPPED: RoleDefinition[] = [
    { name: "bob", tools: ["read", "bash"], skills: [] },
    { name: "gp", tools: ["read"], skills: ["/shipped/skills/part"] },
];
const SHIPPED_TEXT: Record<string, string> = { bob: "Lead the team.", gp: "Carry out a part." };
const REVIEW_TEXT = "Review the work.";
const KNOWN_LEVELS = ["low", "high"];

const teamRole = (overrides: Partial<RoleDefinition> = {}): RoleDefinition => ({
    name: "reviewer",
    tools: ["read"],
    skills: [],
    ...overrides,
});

describe("createRoleCatalog", () => {
    let root: string;
    let file: string;
    let dataDir: string;
    let shippedRoot: string;
    let registeredFolder: string;
    let catalog: RoleCatalog;
    let referrers: Record<string, string[]>;
    let initialText: string;
    let defaultChoice: ModelChoice | undefined;
    let events: string[];
    let store: FileStore;

    const instructionFile = (role: string): string => roleInstructionPath(dataDir, role);
    const instructionText = (role: string): Promise<string> => readFile(instructionFile(role), "utf8");
    const createReviewer = (overrides: Partial<RoleDefinition> = {}, instructions = REVIEW_TEXT) =>
        catalog.create(teamRole(overrides), { instructions });

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
        shippedRoot = join(root, "shipped");
        for (const [role, text] of Object.entries(SHIPPED_TEXT)) {
            await mkdir(join(shippedRoot, "instructions", "roles"), { recursive: true });
            await writeFile(join(shippedRoot, "instructions", "roles", `${role}.md`), text);
        }
        events = [];
        const plainStore = createFileStore();
        store = {
            ...plainStore,
            write: (path, text, options) => {
                events.push(`file:write ${path}`);
                return plainStore.write(path, text, options);
            },
            remove: (path, options) => {
                events.push(`file:remove ${path}`);
                return plainStore.remove(path, options);
            },
        };
        await prepareInternalFolder({ dataDir, shippedRoot, store: plainStore });
        await mkdir(registeredFolder, { mode: 0o700 });
        referrers = {};
        defaultChoice = { model: "p/default", thinkingLevel: "medium" };
        const sections = [rolesSection, workspacesSection];
        const plainConfig = createConfigStore(file, sections, await loadConfig(file, sections));
        const config: ConfigStore = {
            ...plainConfig,
            change: (section, value) => {
                if (section.name === "roles") events.push("table");
                return plainConfig.change(section, value);
            },
        };
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
            instructionPath: instructionFile,
            fileStore: store,
            shippedRoot,
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
        await createReviewer({ model: "p/m", workspace: registeredFolder });
        assert.match(await fileText(), /\[roles\.reviewer\]/);
        assert.deepEqual(catalog.get("reviewer"), {
            ...teamRole({ model: "p/m", workspace: registeredFolder }),
            shipped: false,
            changed: false,
        });

        await catalog.change("reviewer", { thinkingLevel: "high" }, { instructions: "Review harder." });
        assert.equal(catalog.get("reviewer")?.thinkingLevel, "high");
        assert.equal(catalog.get("reviewer")?.model, "p/m");

        await catalog.remove("reviewer");
        assert.doesNotMatch(await fileText(), /\[roles\.reviewer\]/);
        assert.equal(catalog.get("reviewer"), undefined);
    });

    it("writes a created role's instructions to its file and none to the configuration file", async () => {
        await createReviewer();
        assert.equal(await instructionText("reviewer"), REVIEW_TEXT);
        assert.doesNotMatch(await fileText(), /instructions|Review the work/);
    });

    it("writes the instruction file before the table when a role is created", async () => {
        events = [];
        await createReviewer();
        assert.deepEqual(events, [`file:write ${instructionFile("reviewer")}`, "table"]);
    });

    it("replaces an instruction file left with no table when a role is created", async () => {
        await writeFile(instructionFile("reviewer"), "Left behind.");
        await createReviewer();
        assert.equal(await instructionText("reviewer"), REVIEW_TEXT);
        assert.ok(catalog.get("reviewer"));
    });

    it("refuses a create with blank instructions and writes neither file nor table", async () => {
        events = [];
        const error = await refusalOf(() => createReviewer({}, "  \n"));
        assert.deepEqual([error.kind, error.role, error.field], ["invalid", "reviewer", "instructions"]);
        assert.deepEqual(events, []);
        assert.equal(await fileText(), initialText);
    });

    it("writes changed instructions to the file, before the table, and leaves the configuration file free of them", async () => {
        await createReviewer();
        events = [];
        await catalog.change("reviewer", { thinkingLevel: "high" }, { instructions: "Review harder." });
        assert.deepEqual(events, [`file:write ${instructionFile("reviewer")}`, "table"]);
        assert.equal(await instructionText("reviewer"), "Review harder.");
        assert.doesNotMatch(await fileText(), /Review harder/);
    });

    it("leaves the file alone when a change carries no instructions", async () => {
        await createReviewer();
        events = [];
        await catalog.change("reviewer", { thinkingLevel: "high" });
        assert.deepEqual(events, ["table"]);
        assert.equal(await instructionText("reviewer"), REVIEW_TEXT);
    });

    it("refuses a change whose role fields are invalid before writing the file", async () => {
        events = [];
        const error = await refusalOf(() => catalog.change("gp", { tools: ["teleport"] }, { instructions: "New." }));
        assert.equal(error.field, "tools");
        assert.deepEqual(events, []);
        assert.equal(await instructionText("gp"), SHIPPED_TEXT.gp);
    });

    it("refuses a change with blank instructions before writing anything", async () => {
        events = [];
        const error = await refusalOf(() => catalog.change("gp", {}, { instructions: "" }));
        assert.deepEqual([error.kind, error.field], ["invalid", "instructions"]);
        assert.deepEqual(events, []);
    });

    it("writes a shipped role's changed instructions to its file and records no table for them", async () => {
        await catalog.change("gp", {}, { instructions: "Carry out a part, slowly." });
        assert.equal(await instructionText("gp"), "Carry out a part, slowly.");
        assert.equal(await fileText(), initialText);
    });

    it("deletes a removed team role's file after removing its table", async () => {
        await createReviewer();
        events = [];
        await catalog.remove("reviewer");
        assert.deepEqual(events, ["table", `file:remove ${instructionFile("reviewer")}`]);
        await assert.rejects(instructionText("reviewer"), { code: "ENOENT" });
    });

    it("removes a team role whose file is already gone", async () => {
        await createReviewer();
        await rm(instructionFile("reviewer"));
        await catalog.remove("reviewer");
        assert.equal(catalog.get("reviewer"), undefined);
    });

    it("gives a created role without a workspace its per-role default workspace", async () => {
        await createReviewer();
        const seat = catalog.seatFor("reviewer");
        assert.equal(seat.workspace, join(dataDir, "workspaces", "reviewer"));
        assert.doesNotMatch(await fileText(), /workspace =/);
    });

    it("lists a changed shipped role with the new values and then with the shipped values after a restore", async () => {
        await catalog.change("gp", { model: "p/m" });
        assert.deepEqual(
            [catalog.get("gp")?.changed, catalog.get("gp")?.shipped, catalog.get("gp")?.model],
            [true, true, "p/m"],
        );
        assert.match(await fileText(), /\[roles\.gp\]/);

        await catalog.restore("gp");
        assert.deepEqual({ ...catalog.get("gp") }, { ...SHIPPED[1], shipped: true, changed: false });
        assert.doesNotMatch(await fileText(), /\[roles\.gp\]/);
    });

    it("writes the shipped text back to an edited shipped role's file after removing its table's changes", async () => {
        await catalog.change("gp", { model: "p/m" }, { instructions: "Edited." });
        events = [];
        await catalog.restore("gp");
        assert.deepEqual(events, ["table"]);
        assert.equal(await instructionText("gp"), SHIPPED_TEXT.gp);
        assert.equal(catalog.get("gp")?.changed, false);
    });

    it("drops the older instructions key of a restored shipped role with its table", async () => {
        await writeFile(file, '[roles.gp]\ninstructions = "Old text."\nmodel = "p/m"\n');
        const config = createConfigStore(file, [rolesSection], await loadConfig(file, [rolesSection]));
        const older = createRoleCatalog({
            config,
            shipped: SHIPPED,
            workspaces: { isRegistered: () => true } as never,
            dataDir,
            instructionPath: instructionFile,
            fileStore: store,
            shippedRoot,
            models: { checkModelChoice: () => ({ ok: true }), defaultChoice: () => defaultChoice },
        });
        assert.equal(config.current(rolesSection).older.gp?.instructions, "Old text.");
        await older.restore("gp");
        assert.deepEqual(config.current(rolesSection).older, {});
        assert.doesNotMatch(await fileText(), /Old text/);
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
        await createReviewer();
        referrers.reviewer = ["schedule nightly", "schedule weekly"];
        const before = await fileText();
        const error = await refusalOf(() => catalog.remove("reviewer"));
        assert.equal(error.kind, "conflict");
        assert.match(error.message, /schedule nightly/);
        assert.match(error.message, /schedule weekly/);
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
        await createReviewer();
        assert.equal((await refusalOf(() => createReviewer())).kind, "conflict");
        assert.equal(
            (await refusalOf(() => catalog.create(teamRole({ name: "bob" }), { instructions: REVIEW_TEXT }))).kind,
            "conflict",
        );
    });

    it("refuses a create or change that names an unknown tool, naming the role, field and value", async () => {
        const created = await refusalOf(() => createReviewer({ tools: ["read", "teleport"] }));
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
        await createReviewer({ tools: ["read", ...JOB_TOOL_NAMES] });
        assert.deepEqual(catalog.get("reviewer")?.tools, ["read", ...JOB_TOOL_NAMES]);
    });

    it("refuses a create or change that names a model or thinking level the model check refuses", async () => {
        const model = await refusalOf(() => createReviewer({ model: "p/missing" }));
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
        const created = await refusalOf(() => createReviewer({ workspace: unregistered }));
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
        const seat = catalog.seatFor("gp");
        assert.equal(seat.model, "p/default");
        assert.equal(seat.thinkingLevel, "medium");
        assert.equal(seat.workspace, join(dataDir, "workspaces", "gp"));
        assert.equal(seat.role, "gp");
    });

    it("seats a role with its own defaults and the overrides over them", async () => {
        await createReviewer({ model: "p/m", thinkingLevel: "low", workspace: registeredFolder });
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
        await catalog.change("gp", {}, { instructions: "Different." });
        assert.equal(before.instructions, SHIPPED_TEXT.gp);
        assert.equal(catalog.seatFor("gp").instructions, "Different.");
    });

    it("takes a seat's instructions from the role's file, for a shipped and for a team role", async () => {
        await createReviewer();
        assert.equal(catalog.seatFor("bob").instructions, SHIPPED_TEXT.bob);
        assert.equal(catalog.seatFor("reviewer").instructions, REVIEW_TEXT);
        await writeFile(instructionFile("reviewer"), "Edited on disk.");
        assert.equal(catalog.seatFor("reviewer").instructions, "Edited on disk.");
    });

    for (const [state, damage] of [
        ["missing", (path: string) => rm(path)],
        ["empty", (path: string) => writeFile(path, "")],
        ["only white space", (path: string) => writeFile(path, " \n\t\n")],
    ] as const) {
        it(`refuses a seat for a team role whose file is ${state}, naming the file's path`, async () => {
            await createReviewer();
            await damage(instructionFile("reviewer"));
            const error = refusal(() => catalog.seatFor("reviewer"));
            assert.deepEqual([error.kind, error.role, error.field], ["invalid", "reviewer", "instructions"]);
            assert.match(error.message, new RegExp(instructionFile("reviewer")));
        });
    }

    it("seats a shipped role whose file is missing with no instructions", async () => {
        await rm(instructionFile("bob"));
        assert.equal(catalog.seatFor("bob").instructions, "");
    });

    it("names the roles whose own workspace is a path, so the registry refuses to unregister it", async () => {
        await createReviewer({ workspace: registeredFolder });
        await catalog.change("bob", { workspace: registeredFolder });
        assert.deepEqual(catalog.defaultWorkspaceUsers(registeredFolder).sort(), ["bob", "reviewer"]);
        assert.deepEqual(catalog.defaultWorkspaceUsers(join(root, "other")), []);
    });

    it("refuses a configured role whose model or thinking level the model check refuses at startup", async () => {
        catalog.checkConfigured();
        await createReviewer({ model: "p/m", thinkingLevel: "low" });
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
            instructionPath: instructionFile,
            fileStore: store,
            models: { checkModelChoice: () => ({ ok: false, reason: "gone" }), defaultChoice: () => undefined },
        });
        const error = refusal(() => strict.checkConfigured());
        assert.deepEqual([error.kind, error.role, error.field, error.value], ["invalid", "reviewer", "model", "p/m"]);
    });
});
