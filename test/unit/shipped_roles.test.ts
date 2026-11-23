import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAIL_TOOL_SET_ENTRY, SHIPPED_TOOL_NAMES, validateRoleDefinition } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE, SHIPPED_ROLE_NAMES, SHIPPED_ROLES } from "../../src/roles/shipped_roles.ts";

const toolsExpectedOf = (name: string): string[] => {
    if (name === "desk") return [];
    if (name === "triage") return ["read", MAIL_TOOL_SET_ENTRY];
    return [...SHIPPED_TOOL_NAMES];
};

describe("SHIPPED_ROLES", () => {
    it("holds exactly bob, gp, desk and triage, each valid and carrying no instruction text", () => {
        assert.deepEqual(SHIPPED_ROLES.map((role) => role.name).sort(), ["bob", "desk", "gp", "triage"]);
        for (const role of SHIPPED_ROLES) {
            validateRoleDefinition(role);
            assert.equal("instructions" in role, false);
        }
    });

    it("gives bob and gp every shipped tool, desk none and triage read and mail, and no role a default model, thinking level or workspace", () => {
        for (const role of SHIPPED_ROLES) {
            assert.deepEqual(role.tools, toolsExpectedOf(role.name));
            assert.equal(role.model, undefined);
            assert.equal(role.thinkingLevel, undefined);
            assert.equal(role.workspace, undefined);
        }
    });

    it("gives bob, gp, desk and triage the default skill names of S-008 REQ-001", () => {
        const skillsOf = (name: string) => SHIPPED_ROLES.find((role) => role.name === name)?.skills;
        assert.deepEqual(skillsOf("bob"), ["about-the-intern", "bob-command-line"]);
        assert.deepEqual(skillsOf("gp"), ["carry-out-a-part", "bob-command-line"]);
        assert.deepEqual(skillsOf("desk"), ["about-the-intern"]);
        assert.deepEqual(skillsOf("triage"), ["about-the-intern"]);
    });
});

describe("shipped role names", () => {
    it("lists bob, gp, desk and triage and makes bob the default lead", () => {
        assert.deepEqual([...SHIPPED_ROLE_NAMES], ["bob", "gp", "desk", "triage"]);
        assert.equal(DEFAULT_LEAD_ROLE, "bob");
    });
});
