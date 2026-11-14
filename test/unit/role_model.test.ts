import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRONT_DESK_TOOL_NAMES } from "../../src/desk/desk_model.ts";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import {
    applyRoleChange,
    COORDINATION_TOOL_NAMES,
    type RoleDefinition,
    RoleInvalidError,
    resolveSeat,
    SHIPPED_TOOL_NAMES,
    SKILL_TOOL_NAME,
    validateRoleDefinition,
} from "../../src/roles/role_model.ts";

const role = (overrides: Partial<RoleDefinition> = {}): RoleDefinition => ({
    name: "writer",
    tools: ["read", "write"],
    skills: ["style"],
    ...overrides,
});

const defaults = { model: "default-model", thinkingLevel: "low", workspace: "/work/writer" };

const invalidField = (candidate: RoleDefinition): RoleInvalidError => {
    try {
        validateRoleDefinition(candidate);
    } catch (error) {
        assert.ok(error instanceof RoleInvalidError);
        return error;
    }
    throw new Error("expected RoleInvalidError");
};

describe("tool name lists", () => {
    it("lists the shipped and coordination tools", () => {
        assert.deepEqual([...SHIPPED_TOOL_NAMES], ["read", "write", "edit", "bash"]);
        assert.deepEqual([...COORDINATION_TOOL_NAMES], ["handoff", "invoke", "steer"]);
    });
});

describe("resolveSeat", () => {
    it("uses the overrides with the role's tools and skills, and carries no instructions", () => {
        const seat = resolveSeat(
            role({ model: "role-model", thinkingLevel: "high", workspace: "/role/ws" }),
            defaults,
            { model: "o-model", thinkingLevel: "medium", workspace: "/o/ws" },
        );
        assert.equal(seat.role, "writer");
        assert.equal(seat.model, "o-model");
        assert.equal(seat.thinkingLevel, "medium");
        assert.equal(seat.workspace, "/o/ws");
        assert.equal("instructions" in seat, false);
        assert.deepEqual(seat.skills, ["style"]);
        assert.deepEqual(seat.tools, ["read", "write", ...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES, SKILL_TOOL_NAME]);
    });

    it("prefers the role's defaults over the defaults argument", () => {
        const seat = resolveSeat(role({ model: "role-model", thinkingLevel: "high", workspace: "/role/ws" }), defaults);
        assert.equal(seat.model, "role-model");
        assert.equal(seat.thinkingLevel, "high");
        assert.equal(seat.workspace, "/role/ws");
    });

    it("falls back to defaults when the role has no model, thinking level or workspace", () => {
        const seat = resolveSeat(role(), defaults);
        assert.equal(seat.model, "default-model");
        assert.equal(seat.thinkingLevel, "low");
        assert.equal(seat.workspace, "/work/writer");
    });

    it("leaves the thinking level unset when nothing names one", () => {
        const seat = resolveSeat(role(), { model: "m", workspace: "/w" });
        assert.equal(seat.thinkingLevel, undefined);
    });

    it("throws RoleInvalidError with field model when no model is available", () => {
        assert.throws(
            () => resolveSeat(role(), { workspace: "/w" }),
            (error) => error instanceof RoleInvalidError && error.field === "model" && error.role === "writer",
        );
    });

    it("includes every coordination and job tool for a role with an empty tool set", () => {
        const seat = resolveSeat(role({ tools: [] }), defaults);
        assert.deepEqual(seat.tools, [...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES, SKILL_TOOL_NAME]);
    });

    it("does not duplicate coordination or job tools the role already names", () => {
        const seat = resolveSeat(role({ tools: ["invoke", "read", "read_job"] }), defaults);
        assert.deepEqual(seat.tools, [
            "invoke",
            "read",
            "read_job",
            "handoff",
            "steer",
            ...JOB_TOOL_NAMES.filter((name) => name !== "read_job"),
            SKILL_TOOL_NAME,
        ]);
    });
});

describe("resolveSeat in the front desk", () => {
    it("gives the role's tools and the front-desk tools, with no coordination or own-job tool", () => {
        const seat = resolveSeat(role({ tools: ["read", "write"] }), defaults, {}, "front_desk");
        assert.deepEqual(seat.tools, ["read", "write", ...FRONT_DESK_TOOL_NAMES, SKILL_TOOL_NAME]);
        for (const name of ["handoff", "invoke", "steer", "block_job", "complete_job"]) {
            assert.ok(!seat.tools.includes(name), `${name} must not be offered`);
        }
    });

    it("gives the desk role exactly the front-desk tools", () => {
        const seat = resolveSeat(role({ name: "desk", tools: [] }), defaults, {}, "front_desk");
        assert.deepEqual(seat.tools, [...FRONT_DESK_TOOL_NAMES, SKILL_TOOL_NAME]);
    });

    it("keeps the job tools for a seat resolved with the job place", () => {
        const seat = resolveSeat(role({ tools: [] }), defaults, {}, "job");
        assert.deepEqual(seat.tools, [...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES, SKILL_TOOL_NAME]);
    });
});

describe("validateRoleDefinition", () => {
    it("accepts a valid role, including coordination and job tool names", () => {
        validateRoleDefinition(role({ tools: ["read", "bash", "edit", "handoff", ...JOB_TOOL_NAMES] }));
    });

    it("refuses a tool outside both lists, naming role, field and reason", () => {
        const error = invalidField(role({ tools: ["read", "teleport"] }));
        assert.equal(error.role, "writer");
        assert.equal(error.field, "tools");
        assert.match(error.reason, /teleport/);
    });

    for (const name of ["", "Writer", "1writer", "wri_ter", "a".repeat(41)]) {
        it(`refuses the invalid name "${name}"`, () => {
            assert.equal(invalidField(role({ name })).field, "name");
        });
    }

    it("accepts a name of 40 characters", () => {
        validateRoleDefinition(role({ name: "a".repeat(40) }));
    });

    for (const skill of ["", "skills/style", "/skills/style"]) {
        it(`refuses the skill name "${skill}"`, () => {
            const error = invalidField(role({ skills: ["style", skill] }));
            assert.equal(error.field, "skills");
            assert.match(error.reason, new RegExp(`"${skill}"`));
        });
    }

    it("refuses a relative workspace path", () => {
        assert.equal(invalidField(role({ workspace: "ws" })).field, "workspace");
    });
});

describe("applyRoleChange", () => {
    it("replaces only the changed fields", () => {
        const base = role({ model: "m" });
        const changed = applyRoleChange(base, { model: "n", tools: ["edit"] });
        assert.deepEqual(changed, { ...base, model: "n", tools: ["edit"] });
    });

    it("leaves the base unchanged", () => {
        const base = role();
        applyRoleChange(base, { skills: [] });
        assert.deepEqual(base, role());
    });
});
