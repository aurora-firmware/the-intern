import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SHIPPED_TOOL_NAMES, validateRoleDefinition } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE, loadPreamble, SHIPPED_ROLE_NAMES, SHIPPED_ROLES } from "../../src/roles/shipped_roles.ts";

const shippedFolder = fileURLToPath(new URL("../../src/shipped/", import.meta.url));

describe("SHIPPED_ROLES", () => {
    it("holds exactly bob, gp and desk, each valid and carrying no instruction text", () => {
        assert.deepEqual(SHIPPED_ROLES.map((role) => role.name).sort(), ["bob", "desk", "gp"]);
        for (const role of SHIPPED_ROLES) {
            validateRoleDefinition(role);
            assert.equal("instructions" in role, false);
        }
    });

    it("gives bob and gp every shipped tool and desk none, and no role a default model, thinking level or workspace", () => {
        for (const role of SHIPPED_ROLES) {
            assert.deepEqual(role.tools, role.name === "desk" ? [] : [...SHIPPED_TOOL_NAMES]);
            assert.equal(role.model, undefined);
            assert.equal(role.thinkingLevel, undefined);
            assert.equal(role.workspace, undefined);
        }
    });

    it("gives bob, gp and desk the default skill names of S-008 REQ-001", () => {
        const skillsOf = (name: string) => SHIPPED_ROLES.find((role) => role.name === name)?.skills;
        assert.deepEqual(skillsOf("bob"), ["about-the-intern", "bob-command-line"]);
        assert.deepEqual(skillsOf("gp"), ["carry-out-a-part", "bob-command-line"]);
        assert.deepEqual(skillsOf("desk"), ["about-the-intern"]);
    });
});

describe("loadPreamble", () => {
    it("returns the non-empty text of the shipped preamble", async () => {
        const preamble = await loadPreamble();
        assert.notEqual(preamble.trim(), "");
        assert.equal(preamble, await readFile(join(shippedFolder, "instructions", "common.md"), "utf8"));
    });
});

describe("shipped role names", () => {
    it("lists bob, gp and desk and makes bob the default lead", () => {
        assert.deepEqual([...SHIPPED_ROLE_NAMES], ["bob", "gp", "desk"]);
        assert.equal(DEFAULT_LEAD_ROLE, "bob");
    });
});
