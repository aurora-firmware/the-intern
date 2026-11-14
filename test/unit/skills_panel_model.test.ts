/** The Skills panel's pure model (S-008 REQ-013): rows from `skills.list` and `instructions.list`, and when to reload. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    instructionRows,
    type PanelDelta,
    panelReloadNeeded,
    type SkillListResult,
    type SkillResult,
    skillRows,
} from "../../web/ui/model/skills.ts";

const skill = (overrides: Partial<SkillResult> = {}): SkillResult => ({
    name: "code-review",
    description: "Review a change",
    source: { kind: "path", path: "/skills" },
    path: "/skills/code-review/SKILL.md",
    enabled: false,
    shipped: false,
    edited: false,
    shadowed: [],
    ...overrides,
});

const list = (skills: SkillResult[], extra: Partial<SkillListResult> = {}): SkillListResult => ({
    skills,
    missing: [],
    leftOut: [],
    ...extra,
});

describe("skillRows", () => {
    it("puts a shadowed copy under the copy in use", () => {
        const rows = skillRows(
            list([
                skill({
                    shadowed: [{ path: "/other/code-review/SKILL.md", source: { kind: "internal" } }],
                }),
            ]),
        );
        assert.deepEqual(rows.skills[0]?.shadowed, [{ sourceText: "internal", path: "/other/code-review/SKILL.md" }]);
    });

    it("shows a workspace skill checked and not changeable", () => {
        const row = skillRows(
            list([skill({ source: { kind: "workspace", path: "/ws/.agents/skills" }, enabled: false })]),
        ).skills[0];
        assert.equal(row?.isChecked, true);
        assert.equal(row?.isChangeable, false);
    });

    it("shows other skills with a check box that follows enabled and can change", () => {
        const [on, off] = skillRows(list([skill({ enabled: true }), skill({ name: "x", enabled: false })])).skills;
        assert.deepEqual(
            [on?.isChecked, on?.isChangeable, off?.isChecked, off?.isChangeable],
            [true, true, false, true],
        );
    });

    it("carries name, description, source text and path", () => {
        const row = skillRows(list([skill()])).skills[0];
        assert.deepEqual(
            [row?.name, row?.description, row?.sourceText, row?.path],
            ["code-review", "Review a change", "path /skills", "/skills/code-review/SKILL.md"],
        );
    });

    it("words the marks: edited, and deleted instead of edited", () => {
        const [edited, deleted, plain] = skillRows(
            list([skill({ edited: true }), skill({ edited: true, deleted: true }), skill()]),
        ).skills;
        assert.deepEqual([edited?.marks, deleted?.marks, plain?.marks], [["edited"], ["deleted"], []]);
    });

    it("returns missing names and left-out paths with the reason", () => {
        const rows = skillRows(list([], { missing: ["gone"], leftOut: [{ path: "/p", reason: "not a folder" }] }));
        assert.deepEqual(rows.missing, ["gone"]);
        assert.deepEqual(rows.leftOut, [{ path: "/p", reason: "not a folder" }]);
    });
});

describe("instructionRows", () => {
    it("keeps the order and words the marks", () => {
        const rows = instructionRows({
            files: [
                { kind: "common", path: "/c.md", shipped: true, edited: true, missing: false },
                { kind: "role", path: "/r.md", shipped: false, edited: false, missing: true },
            ],
        });
        assert.deepEqual(rows, [
            { kind: "common", path: "/c.md", marks: ["shipped", "edited"] },
            { kind: "role", path: "/r.md", marks: ["missing"] },
        ]);
    });
});

describe("panelReloadNeeded", () => {
    const skills = (conversationId: string): PanelDelta => ({
        type: "skills_changed",
        conversationId,
        enabledSkills: [],
    });

    it("asks for a reload on a skills_changed delta of the panel's conversation", () => {
        assert.equal(panelReloadNeeded(skills("c1"), "c1"), true);
    });

    it("does not ask for a reload on a skills_changed delta of another conversation", () => {
        assert.equal(panelReloadNeeded(skills("c2"), "c1"), false);
    });

    it("does not ask for a reload on a skills_changed delta when the panel has no conversation", () => {
        assert.equal(panelReloadNeeded(skills("c2"), null), false);
    });

    it("asks for a reload on settings_changed and files_changed deltas", () => {
        assert.equal(panelReloadNeeded({ type: "settings_changed", section: "roles" }, null), true);
        assert.equal(panelReloadNeeded({ type: "files_changed", path: "/p", kind: "skill" }, "c1"), true);
    });

    it("ignores other deltas", () => {
        assert.equal(panelReloadNeeded({ type: "run_started", conversationId: "c1" }, "c1"), false);
    });
});
