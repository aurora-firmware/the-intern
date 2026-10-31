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
    instructions: "Review the work.",
    tools: ["read", "bash"],
    skills: ["/skills/review"],
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
                    instructions: "Review the work.",
                    tools: ["read", "bash"],
                    skills: ["/skills/review"],
                    model: "provider/id",
                    thinkingLevel: "low",
                    workspace: "/work/review",
                },
            },
            shippedChanges: { bob: { model: "provider/other" } },
        });
    });

    it("serializes to a table that parses back to the same value", () => {
        const value = rolesSection.parse({
            reviewer: reviewerTable,
            writer: { instructions: "Write.", tools: ["write"] },
            bob: { thinking_level: "high", skills: ["/skills/x"] },
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

    it("names the role and the field when a skill path is relative", () => {
        const error = failure(() => rolesSection.parse({ reviewer: { ...reviewerTable, skills: ["skills/x"] } }));
        assert.equal(error.key, "reviewer.skills");
    });

    it("names the role and the field when a change holds a relative workspace", () => {
        assert.equal(failure(() => rolesSection.parse({ bob: { workspace: "rel" } })).key, "bob.workspace");
    });

    it("names the role and the field when a team role lacks instructions", () => {
        const error = failure(() => rolesSection.parse({ reviewer: { tools: ["read"] } }));
        assert.equal(error.key, "reviewer.instructions");
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
        assert.deepEqual(rolesSection.defaults(), { teamRoles: {}, shippedChanges: {} });
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
