import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { LogFields, Logger } from "../../src/daemon/logger.ts";
import { createWorkspaceContextLoader } from "../../src/prompt/workspace_context.ts";
import type { Seat } from "../../src/roles/role_model.ts";

type LogEntry = { message: string; fields: LogFields };

function recordingLogger(entries: LogEntry[]): Logger {
    const record = (message: string, fields: LogFields = {}) => entries.push({ message, fields });
    return { error: record, info: record, debug: record };
}

async function writeSkill(dir: string, name: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things\n---\nBody\n`);
}

describe("createWorkspaceContextLoader", () => {
    let root: string;
    let workspace: string;
    let entries: LogEntry[];

    const makeSeat = (skills: string[] = []): Seat => ({
        role: "writer",
        model: "fake/model",
        workspace,
        instructions: "",
        tools: [],
        skills,
    });

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "workspace-context-"));
        workspace = join(root, "parent", "workspace");
        await mkdir(workspace, { recursive: true });
        entries = [];
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("loads workspace and parent context files and workspace skills", async () => {
        await writeFile(join(workspace, "AGENTS.md"), "workspace rules");
        await writeFile(join(root, "parent", "AGENTS.md"), "parent rules");
        await writeSkill(join(workspace, ".pi", "skills", "local-skill"), "local-skill");

        const context = createWorkspaceContextLoader({ logger: recordingLogger(entries) }).load(makeSeat());

        const contents = context.contextFiles.map((file) => file.content);
        assert.ok(contents.includes("workspace rules"));
        assert.ok(contents.includes("parent rules"));
        assert.deepEqual(
            context.workspaceSkills.map((skill) => skill.name),
            ["local-skill"],
        );
        assert.deepEqual(context.roleSkills, []);
    });

    it("loads the role skills named by the seat", async () => {
        const skillDir = join(root, "role-skills", "role-skill");
        await writeSkill(skillDir, "role-skill");

        const context = createWorkspaceContextLoader({ logger: recordingLogger(entries) }).load(makeSeat([skillDir]));

        assert.deepEqual(
            context.roleSkills.map((skill) => skill.name),
            ["role-skill"],
        );
    });

    it("leaves out a missing skill folder and logs its path", () => {
        const missing = join(root, "no-such-skill");

        const context = createWorkspaceContextLoader({ logger: recordingLogger(entries) }).load(makeSeat([missing]));

        assert.deepEqual(context.roleSkills, []);
        assert.ok(entries.some((entry) => String(entry.fields.path).includes(missing)));
    });

    it("leaves out a skill with an invalid SKILL.md and logs its path", async () => {
        const skillDir = join(root, "broken-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), "no frontmatter at all");

        const context = createWorkspaceContextLoader({ logger: recordingLogger(entries) }).load(makeSeat([skillDir]));

        assert.deepEqual(context.roleSkills, []);
        assert.ok(entries.some((entry) => String(entry.fields.path).includes(skillDir)));
    });

    it("returns equal results for the same workspace and skills without reading the files again", async () => {
        await writeFile(join(workspace, "AGENTS.md"), "workspace rules");
        const loader = createWorkspaceContextLoader({ logger: recordingLogger(entries) });
        const first = loader.load(makeSeat());

        await rm(join(workspace, "AGENTS.md"));
        const second = loader.load(makeSeat());

        assert.deepEqual(second, first);
    });

    it("loads again for a different skill list", async () => {
        const skillDir = join(root, "role-skills", "role-skill");
        await writeSkill(skillDir, "role-skill");
        const loader = createWorkspaceContextLoader({ logger: recordingLogger(entries) });

        const without = loader.load(makeSeat());
        const withSkill = loader.load(makeSeat([skillDir]));

        assert.equal(without.roleSkills.length, 0);
        assert.equal(withSkill.roleSkills.length, 1);
    });
});
