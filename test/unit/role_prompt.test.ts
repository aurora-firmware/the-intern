import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { type RolePromptInput, renderRolePrompt } from "../../src/prompt/role_prompt.ts";
import type { Seat } from "../../src/roles/role_model.ts";

const seat: Seat = {
    role: "writer",
    model: "fake/model",
    workspace: "/work/space",
    instructions: "Write clearly.",
    tools: [],
    skills: [],
};

function makeSkill(name: string): Skill {
    return {
        name,
        description: `${name} description`,
        filePath: `/skills/${name}/SKILL.md`,
        baseDir: `/skills/${name}`,
        sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "test", scope: "project", origin: "top-level" },
        disableModelInvocation: false,
    } as Skill;
}

function makeInput(overrides: Partial<RolePromptInput> = {}): RolePromptInput {
    return {
        preamble: "You are the intern.",
        seat,
        contextFiles: [{ path: "/work/space/AGENTS.md", content: "Be careful." }],
        roleSkills: [makeSkill("role-skill")],
        workspaceSkills: [makeSkill("workspace-skill")],
        ...overrides,
    };
}

describe("renderRolePrompt", () => {
    it("returns byte-identical sections for equal input", () => {
        const first = renderRolePrompt(makeInput());
        const second = renderRolePrompt(makeInput());
        assert.equal(JSON.stringify(first), JSON.stringify(second));
    });

    it("renders each part as its own section in order", () => {
        const sections = renderRolePrompt(makeInput());
        assert.deepEqual(
            sections.map((section) => section.key),
            [
                "intern.preamble",
                "intern.role",
                "intern.role-skills",
                "intern.workspace-context",
                "intern.workspace-skills",
            ],
        );
        assert.equal(sections[0]?.text, "You are the intern.");
        assert.equal(sections[1]?.text, "Write clearly.");
        assert.match(sections[2]?.text ?? "", /role-skill/);
        assert.match(sections[4]?.text ?? "", /workspace-skill/);
    });

    it("names the workspace path and lists the context files in the workspace section", () => {
        const text = renderRolePrompt(makeInput()).find((section) => section.key === "intern.workspace-context")?.text;
        assert.match(text ?? "", /\/work\/space\b/);
        assert.match(text ?? "", /\/work\/space\/AGENTS\.md/);
        assert.match(text ?? "", /Be careful\./);
    });

    it("renders no section for an empty part", () => {
        const sections = renderRolePrompt(
            makeInput({ seat: { ...seat, instructions: "" }, contextFiles: [], roleSkills: [], workspaceSkills: [] }),
        );
        assert.deepEqual(
            sections.map((section) => section.key),
            ["intern.preamble", "intern.workspace-context"],
        );
    });

    it("renders no preamble section for an empty preamble", () => {
        const sections = renderRolePrompt(makeInput({ preamble: "" }));
        assert.equal(sections[0]?.key, "intern.role");
    });
});
