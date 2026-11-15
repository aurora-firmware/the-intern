import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ConversationMeta } from "../../src/host/seating.ts";
import { readPromptParts } from "../../src/prompt/prompt_sources.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { commonPromptPath, roleInstructionPath } from "../../src/skills/internal_folder.ts";
import type { DiagnosticLog } from "../../src/skills/skill_discovery.ts";

async function writeSkill(dir: string, name: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things\n---\nBody\n`);
}

describe("readPromptParts", () => {
    let root: string;
    let workspace: string;
    let dataDir: string;
    let reported: (readonly string[])[];

    const diagnostics: DiagnosticLog = { report: (list) => reported.push(list) };
    const seat = (): Seat => ({
        role: "writer",
        model: "fake/model",
        workspace,
        instructions: "",
        tools: [],
        skills: [],
    });
    const metaOf = (overrides: Partial<ConversationMeta> = {}): ConversationMeta =>
        ({ jobId: "job-1", isLead: false, seat: seat(), ...overrides }) as ConversationMeta;
    const read = (meta: ConversationMeta, defaultsOf: (role: string) => ReadonlySet<string> = () => new Set()) =>
        readPromptParts({ meta, dataDir, searchPaths: [], defaultsOf, diagnostics });

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "prompt-sources-"));
        workspace = join(root, "parent", "workspace");
        dataDir = join(root, "data");
        await mkdir(workspace, { recursive: true });
        await mkdir(join(dataDir, "instructions", "roles"), { recursive: true });
        reported = [];
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("reads the workspace and parent context files and the workspace skills", async () => {
        await writeFile(join(workspace, "AGENTS.md"), "workspace rules");
        await writeFile(join(root, "parent", "AGENTS.md"), "parent rules");
        await writeSkill(join(workspace, ".pi", "skills", "local-skill"), "local-skill");

        const parts = await read(metaOf());

        const contents = parts.contextFiles.map((file) => file.content);
        assert.ok(contents.includes("workspace rules"));
        assert.ok(contents.includes("parent rules"));
        assert.deepEqual(
            parts.skills.map((skill) => skill.name),
            ["local-skill"],
        );
        assert.equal(parts.workspace, workspace);
    });

    it("returns no context file or skill from the pi agent folder", async () => {
        const agentDir = join(root, "agent");
        await writeFile(join(workspace, "AGENTS.md"), "workspace rules");
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, "AGENTS.md"), "account rules");
        await writeSkill(join(agentDir, "skills", "account-skill"), "account-skill");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const parts = await read(metaOf({ enabledSkills: ["account-skill"] }));

            const contents = parts.contextFiles.map((file) => file.content);
            assert.ok(contents.includes("workspace rules"));
            assert.ok(!contents.includes("account rules"));
            assert.deepEqual(parts.skills, []);
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it("reads the common prompt, the role's file and the lead mark", async () => {
        await writeFile(commonPromptPath(dataDir), "common text");
        await writeFile(roleInstructionPath(dataDir, "writer"), "writer text");

        const parts = await read(metaOf({ isLead: true }));

        assert.equal(parts.common, "common text");
        assert.equal(parts.role, "writer text");
        assert.equal(parts.isLead, true);
        assert.deepEqual(reported, [[]]);
    });

    it("reads an edited file again on the next call", async () => {
        await writeFile(commonPromptPath(dataDir), "first");
        await read(metaOf());

        await writeFile(commonPromptPath(dataDir), "second");

        assert.equal((await read(metaOf())).common, "second");
    });

    it("leaves out a missing common prompt and role file and reports each path", async () => {
        const parts = await read(metaOf());

        assert.equal(parts.common, undefined);
        assert.equal(parts.role, undefined);
        assert.equal(reported.length, 1);
        assert.equal(reported[0]?.length, 2);
        assert.ok(reported[0]?.some((problem) => problem.includes(commonPromptPath(dataDir))));
        assert.ok(reported[0]?.some((problem) => problem.includes(roleInstructionPath(dataDir, "writer"))));
    });

    it("lists the skills of the enabled set from the internal folder", async () => {
        await writeSkill(join(dataDir, "skills", "alpha"), "alpha");
        await writeSkill(join(dataDir, "skills", "beta"), "beta");

        const parts = await read(metaOf({ enabledSkills: ["beta"] }));

        assert.deepEqual(
            parts.skills.map((skill) => skill.name),
            ["beta"],
        );
    });

    it("uses the role's default skills when the document holds no enabled set", async () => {
        await writeSkill(join(dataDir, "skills", "alpha"), "alpha");
        await writeSkill(join(dataDir, "skills", "beta"), "beta");

        const parts = await read(metaOf(), (role) => new Set(role === "writer" ? ["alpha"] : []));

        assert.deepEqual(
            parts.skills.map((skill) => skill.name),
            ["alpha"],
        );
    });

    it("reads skills from the search paths and reports a catalog diagnostic", async () => {
        const missing = join(root, "no-such-folder");
        await writeSkill(join(root, "extra", "gamma"), "gamma");

        const parts = await readPromptParts({
            meta: metaOf({ enabledSkills: ["gamma"] }),
            dataDir,
            searchPaths: [join(root, "extra"), missing],
            defaultsOf: () => new Set(),
            diagnostics,
        });

        assert.deepEqual(
            parts.skills.map((skill) => skill.name),
            ["gamma"],
        );
        assert.ok(reported[0]?.some((problem) => problem.includes(missing)));
    });
});
