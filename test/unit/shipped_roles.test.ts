import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SHIPPED_TOOL_NAMES, validateRoleDefinition } from "../../src/roles/role_model.ts";
import {
    DEFAULT_LEAD_ROLE,
    loadPreamble,
    loadShippedRoles,
    SHIPPED_ROLE_NAMES,
} from "../../src/roles/shipped_roles.ts";

const shippedFolder = fileURLToPath(new URL("../../src/roles/shipped/", import.meta.url));

describe("loadShippedRoles", () => {
    it("returns exactly bob and gp, each valid with non-empty instructions", async () => {
        const roles = await loadShippedRoles();
        assert.deepEqual(roles.map((role) => role.name).sort(), ["bob", "gp"]);
        for (const role of roles) {
            validateRoleDefinition(role);
            assert.notEqual(role.instructions.trim(), "");
        }
    });

    it("reads each role's instructions from its file in the package", async () => {
        const roles = await loadShippedRoles();
        for (const role of roles) {
            const text = await readFile(join(shippedFolder, `${role.name}.md`), "utf8");
            assert.equal(role.instructions, text);
        }
    });

    it("gives both roles every shipped tool and no default model, thinking level or workspace", async () => {
        for (const role of await loadShippedRoles()) {
            assert.deepEqual(role.tools, [...SHIPPED_TOOL_NAMES]);
            assert.equal(role.model, undefined);
            assert.equal(role.thinkingLevel, undefined);
            assert.equal(role.workspace, undefined);
        }
    });

    it("gives gp the absolute carry-out-a-part skill folder holding a SKILL.md and bob no skills", async () => {
        const roles = await loadShippedRoles();
        const bob = roles.find((role) => role.name === "bob");
        const gp = roles.find((role) => role.name === "gp");
        assert.deepEqual(bob?.skills, []);
        assert.equal(gp?.skills.length, 1);
        const skillFolder = gp?.skills[0] ?? "";
        assert.ok(isAbsolute(skillFolder));
        assert.equal(skillFolder, join(shippedFolder, "skills", "carry-out-a-part"));
        assert.ok((await stat(join(skillFolder, "SKILL.md"))).isFile());
    });
});

describe("loadPreamble", () => {
    it("returns the non-empty text of the shipped preamble", async () => {
        const preamble = await loadPreamble();
        assert.notEqual(preamble.trim(), "");
        assert.equal(preamble, await readFile(join(shippedFolder, "preamble.md"), "utf8"));
    });
});

describe("shipped role names", () => {
    it("lists bob and gp and makes bob the default lead", () => {
        assert.deepEqual([...SHIPPED_ROLE_NAMES], ["bob", "gp"]);
        assert.equal(DEFAULT_LEAD_ROLE, "bob");
    });
});
