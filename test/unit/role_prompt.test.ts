import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { LEAD_DUTY, type RolePromptInput, renderRolePrompt } from "../../src/prompt/role_prompt.ts";
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
        isLead: false,
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

    it("renders the lead duty right after the role for a lead, whatever role is seated", () => {
        for (const instructions of ["Write clearly.", "Review carefully."]) {
            const sections = renderRolePrompt(makeInput({ isLead: true, seat: { ...seat, instructions } }));
            const keys = sections.map((section) => section.key);
            assert.equal(keys.indexOf("intern.lead-duty"), keys.indexOf("intern.role") + 1);
            assert.equal(sections.find((section) => section.key === "intern.lead-duty")?.text, LEAD_DUTY);
        }
    });

    it("leaves the lead duty out when the conversation is not a lead", () => {
        const keys = renderRolePrompt(makeInput({ isLead: false })).map((section) => section.key);
        assert.equal(keys.includes("intern.lead-duty"), false);
    });

    it("names the definition of done, the reason, the evidence and the three tools", () => {
        assert.match(LEAD_DUTY, /definition of done/);
        assert.match(LEAD_DUTY, /reason/);
        assert.match(LEAD_DUTY, /evidence/);
        assert.match(LEAD_DUTY, /justification/);
        for (const tool of ["update_job", "block_job", "complete_job"]) assert.ok(LEAD_DUTY.includes(tool), tool);
    });

    it("renders the lead duty byte-identically on every request", () => {
        const first = renderRolePrompt(makeInput({ isLead: true }));
        const second = renderRolePrompt(makeInput({ isLead: true }));
        const dutyOf = (sections: typeof first) => sections.find((section) => section.key === "intern.lead-duty")?.text;
        assert.equal(dutyOf(first), dutyOf(second));
        assert.equal(JSON.stringify(first), JSON.stringify(second));
    });
});
