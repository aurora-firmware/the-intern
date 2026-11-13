import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigValueError } from "../../src/config/config_file.ts";
import { rolesSection, workspacesSection } from "../../src/roles/roles_section.ts";

const failure = (run: () => unknown): ConfigValueError => {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof ConfigValueError, `expected ConfigValueError, got ${String(error)}`);
        return error;
    }
    throw new Error("expected ConfigValueError");
};

const reviewerTable = {
    tools: ["read", "bash"],
    skills: ["review"],
    model: "provider/id",
    thinking_level: "low",
    workspace: "/work/review",
};

describe("rolesSection", () => {
    it("parses a team role and a change to bob into teamRoles and shippedChanges", () => {
        const value = rolesSection.parse({ reviewer: reviewerTable, bob: { model: "provider/other" } });
        assert.deepEqual(value, {
            teamRoles: {
                reviewer: {
                    name: "reviewer",
                    tools: ["read", "bash"],
                    skills: ["review"],
                    model: "provider/id",
                    thinkingLevel: "low",
                    workspace: "/work/review",
                },
            },
            shippedChanges: { bob: { model: "provider/other" } },
            older: {},
        });
    });

    it("accepts a team role with no instructions key", () => {
        const value = rolesSection.parse({ reviewer: { tools: ["read"] } });
        assert.deepEqual(value.teamRoles.reviewer, { name: "reviewer", tools: ["read"], skills: [] });
        assert.deepEqual(value.older, {});
    });

    it("keeps an instructions string of a team role and of a shipped role as an older key", () => {
        const value = rolesSection.parse({
            reviewer: { ...reviewerTable, instructions: "Review the work." },
            bob: { instructions: "Lead.", model: "provider/other" },
        });
        assert.deepEqual(value.older, {
            reviewer: { instructions: "Review the work." },
            bob: { instructions: "Lead." },
        });
        assert.equal("instructions" in (value.teamRoles.reviewer ?? {}), false);
        assert.deepEqual(value.shippedChanges.bob, { model: "provider/other" });
    });

    it("writes the older instructions key back unchanged", () => {
        const table = {
            reviewer: { instructions: "Review the work.", tools: ["read"] },
            bob: { instructions: "Lead.", model: "provider/other" },
        };
        assert.deepEqual(rolesSection.serialize(rolesSection.parse(table)), table);
    });

    it("names the role and the field when the older instructions key is empty or not a string", () => {
        const empty = failure(() => rolesSection.parse({ reviewer: { instructions: " ", tools: ["read"] } }));
        assert.deepEqual([empty.key, empty.reason], ["reviewer.instructions", "instructions are empty"]);
        assert.equal(failure(() => rolesSection.parse({ bob: { instructions: 5 } })).key, "bob.instructions");
    });

    it("serializes to a table that parses back to the same value", () => {
        const value = rolesSection.parse({
            reviewer: reviewerTable,
            writer: { instructions: "Write.", tools: ["write"] },
            editor: { tools: ["read"] },
            bob: { thinking_level: "high", skills: ["x"] },
        });
        assert.deepEqual(rolesSection.parse(rolesSection.serialize(value)), value);
    });

    it("serializes a change with only its changed keys", () => {
        const value = rolesSection.parse({ bob: { model: "provider/id" } });
        assert.deepEqual(rolesSection.serialize(value), { bob: { model: "provider/id" } });
    });

    it("names the role and the field when a role table has an unknown key", () => {
        assert.equal(failure(() => rolesSection.parse({ bob: { colour: "red" } })).key, "bob.colour");
    });

    it("names the role and the field when a tool is not a shipped or coordination name", () => {
        const error = failure(() => rolesSection.parse({ reviewer: { ...reviewerTable, tools: ["read", "fly"] } }));
        assert.equal(error.key, "reviewer.tools");
    });

    it("names the role, the field and the name when a skill name holds a slash or is empty", () => {
        for (const skill of ["skills/x", ""]) {
            const error = failure(() => rolesSection.parse({ reviewer: { ...reviewerTable, skills: [skill] } }));
            assert.equal(error.key, "reviewer.skills");
            assert.match(error.reason, new RegExp(`"${skill}"`));
        }
        assert.equal(failure(() => rolesSection.parse({ bob: { skills: ["a/b"] } })).key, "bob.skills");
    });

    it("keeps an absolute skill path of a team role as an older key and leaves it out of its skills", () => {
        const value = rolesSection.parse({ reviewer: { tools: ["read"], skills: ["review", "/skills/old"] } });
        assert.deepEqual(value.teamRoles.reviewer?.skills, ["review"]);
        assert.deepEqual(value.older, { reviewer: { skillPaths: ["/skills/old"] } });
    });

    it("keeps an absolute skill path of a shipped role as an older key", () => {
        const value = rolesSection.parse({ bob: { skills: ["/skills/old"] } });
        assert.deepEqual(value.shippedChanges.bob, { skills: [] });
        assert.deepEqual(value.older, { bob: { skillPaths: ["/skills/old"] } });
    });

    it("writes the skill names, then the older skill paths, back unchanged", () => {
        const table = {
            reviewer: { tools: ["read"], skills: ["review", "/skills/old"] },
            bob: { skills: ["about-the-intern", "/skills/older"] },
            gp: { skills: ["/skills/only"] },
        };
        assert.deepEqual(rolesSection.serialize(rolesSection.parse(table)), table);
    });

    it("leaves a shipped role's skills unchanged when its table has no skills key", () => {
        const value = rolesSection.parse({ bob: { model: "provider/id" } });
        assert.equal("skills" in (value.shippedChanges.bob ?? {}), false);
    });

    it("names the role and the field when a change holds a relative workspace", () => {
        assert.equal(failure(() => rolesSection.parse({ bob: { workspace: "rel" } })).key, "bob.workspace");
    });

    it("names the role and the field when a team role lacks tools", () => {
        const error = failure(() => rolesSection.parse({ reviewer: { instructions: "Review." } }));
        assert.equal(error.key, "reviewer.tools");
    });

    it("names the role and the field when a value has the wrong type", () => {
        assert.equal(failure(() => rolesSection.parse({ bob: { model: 3 } })).key, "bob.model");
        assert.equal(failure(() => rolesSection.parse({ bob: "x" })).key, "bob");
    });

    it("uses no team roles and no changes by default", () => {
        assert.deepEqual(rolesSection.defaults(), { teamRoles: {}, shippedChanges: {}, older: {} });
        assert.equal(rolesSection.name, "roles");
    });
});

describe("workspacesSection", () => {
    it("parses absolute paths into registered in order", () => {
        const value = workspacesSection.parse({ registered: ["/b", "/a"] });
        assert.deepEqual(value, { registered: ["/b", "/a"] });
        assert.deepEqual(workspacesSection.parse(workspacesSection.serialize(value)), value);
    });

    it("names registered when a path is relative", () => {
        assert.equal(failure(() => workspacesSection.parse({ registered: ["rel/dir"] })).key, "registered");
    });

    it("names registered when a path is listed twice", () => {
        assert.equal(failure(() => workspacesSection.parse({ registered: ["/a", "/a"] })).key, "registered");
    });

    it("refuses an unknown key", () => {
        assert.equal(failure(() => workspacesSection.parse({ other: [] })).key, "other");
    });

    it("uses no registered workspaces by default", () => {
        assert.deepEqual(workspacesSection.defaults(), { registered: [] });
        assert.equal(workspacesSection.name, "workspaces");
    });
});
