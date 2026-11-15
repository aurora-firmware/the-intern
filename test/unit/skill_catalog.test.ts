import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../../src/daemon/logger.ts";
import { createFileStore } from "../../src/skills/file_store.ts";
import { prepareInternalFolder, skillsFolderPath } from "../../src/skills/internal_folder.ts";
import { createDiagnosticLog, readCatalog } from "../../src/skills/skill_discovery.ts";

const skillText = (description: string) => `---\ndescription: ${description}\n---\nBody\n`;

async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}

describe("readCatalog", () => {
    let base: string;
    let dataDir: string;
    let shippedRoot: string;
    const read = (searchPaths: string[] = [], workspace?: string) =>
        readCatalog({ dataDir, shippedRoot, searchPaths, workspace });

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), "bob-skill-catalog-"));
        dataDir = join(base, "data");
        shippedRoot = join(base, "shipped");
        await put(join(shippedRoot, "skills/alpha/SKILL.md"), skillText("Shipped alpha"));
        await put(join(shippedRoot, "skills/alpha/notes/more.md"), "more");
        await put(join(shippedRoot, "skills/beta/SKILL.md"), skillText("Shipped beta"));
        await prepareInternalFolder({ dataDir, shippedRoot, store: createFileStore() });
    });

    afterEach(() => rm(base, { recursive: true, force: true }));

    it("uses the internal folder, then the search paths in order, then the workspace", async () => {
        const first = join(base, "first");
        const second = join(base, "second");
        const workspace = join(base, "ws");
        await put(join(first, "alpha/SKILL.md"), skillText("First alpha"));
        await put(join(first, "beta/SKILL.md"), skillText("First beta"));
        await put(join(second, "beta/SKILL.md"), skillText("Second beta"));
        await put(join(workspace, ".pi/skills/beta/SKILL.md"), skillText("Workspace beta"));

        const catalog = await read([first, second], workspace);

        const byName = Object.fromEntries(catalog.skills.map((skill) => [skill.name, skill]));
        assert.equal(byName.alpha?.description, "First alpha");
        assert.deepEqual(byName.alpha?.source, { kind: "path", path: first });
        assert.equal(byName.beta?.description, "Workspace beta");
        assert.deepEqual(byName.beta?.source, { kind: "workspace", path: join(workspace, ".pi/skills") });
        assert.deepEqual(
            byName.beta?.shadowed.map((copy) => copy.source.kind),
            ["path", "path", "internal"],
        );
    });

    it("reads the sources again at every call", async () => {
        assert.equal((await read()).skills.length, 2);
        await put(join(skillsFolderPath(dataDir), "gamma/SKILL.md"), skillText("Gamma"));

        assert.equal((await read()).skills.length, 3);
    });

    it("marks a shipped skill as shipped and not edited until a team member edits it", async () => {
        const before = (await read()).skills.find((skill) => skill.name === "alpha");
        assert.equal(before?.shipped, true);
        assert.equal(before?.edited, false);

        await writeFile(join(skillsFolderPath(dataDir), "alpha/notes/more.md"), "changed");

        const after = (await read()).skills.find((skill) => skill.name === "alpha");
        assert.equal(after?.edited, true);
        const other = (await read()).skills.find((skill) => skill.name === "beta");
        assert.equal(other?.edited, false);
    });

    it("does not mark a skill the team member added as shipped", async () => {
        await put(join(skillsFolderPath(dataDir), "mine/SKILL.md"), skillText("Mine"));

        const mine = (await read()).skills.find((skill) => skill.name === "mine");

        assert.equal(mine?.shipped, false);
        assert.equal(mine?.edited, false);
    });

    it("lists a shipped skill whose folder was deleted in deletedShipped", async () => {
        await rm(join(skillsFolderPath(dataDir), "beta"), { recursive: true });

        const catalog = await read();

        assert.deepEqual(
            catalog.skills.map((skill) => skill.name),
            ["alpha"],
        );
        assert.deepEqual(catalog.deletedShipped, [{ name: "beta", folder: join(skillsFolderPath(dataDir), "beta") }]);
    });

    it("adds a diagnostic naming a missing search path and reads the other sources", async () => {
        const missing = join(base, "nowhere");

        const catalog = await read([missing]);

        assert.equal(catalog.skills.length, 2);
        assert.equal(catalog.diagnostics.length, 1);
        assert.ok(catalog.diagnostics[0]?.includes(missing));
    });

    it("adds no diagnostic for a workspace without .pi/skills", async () => {
        const catalog = await read([], join(base, "empty-ws"));

        assert.deepEqual(catalog.diagnostics, []);
        assert.equal(catalog.skills.length, 2);
    });
});

describe("createDiagnosticLog", () => {
    const makeLog = () => {
        const lines: string[] = [];
        const logger: Logger = {
            error: (message) => lines.push(message),
            info: (message) => lines.push(message),
            debug: () => {},
        };
        return { lines, log: createDiagnosticLog(logger) };
    };

    it("logs a diagnostic reported twice in a row once", () => {
        const { lines, log } = makeLog();

        log.report(["/p/x/SKILL.md: skill is broken"]);
        log.report(["/p/x/SKILL.md: skill is broken"]);

        assert.equal(lines.length, 1);
        assert.ok(lines[0]?.includes("/p/x/SKILL.md: skill is broken"));
    });

    it("logs a diagnostic again after it has gone and come back", () => {
        const { lines, log } = makeLog();

        log.report(["a: broken"]);
        log.report([]);
        log.report(["a: broken"]);

        assert.equal(lines.length, 2);
    });

    it("keeps logging other diagnostics while one stays", () => {
        const { lines, log } = makeLog();

        log.report(["a: broken"]);
        log.report(["a: broken", "b: broken"]);

        assert.equal(lines.length, 2);
    });
});
