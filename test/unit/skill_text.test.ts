/**
 * What `bob skills` and `bob instructions` print (S-008 REQ-012): names, paths, sources and marks as words, shadowed
 * copies under the copy in use, never file text, and no control sequence from data.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instructionListText, searchPathsText, skillListText, skillText } from "../../src/cli/skill_text.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CLIPBOARD_WRITE = `${ESC}]52;c;ZXZpbA==${BEL}`;

type Listing = Parameters<typeof skillListText>[0];
type ListedSkill = Listing["skills"][number];

function skill(overrides: Partial<ListedSkill> = {}): ListedSkill {
    return {
        name: "review",
        description: "Reviews work",
        source: { kind: "internal" },
        path: "/data/skills/review",
        enabled: false,
        shipped: false,
        edited: false,
        shadowed: [],
        ...overrides,
    };
}

function listing(overrides: Partial<Listing> = {}): Listing {
    return { skills: [], missing: [], leftOut: [], ...overrides };
}

describe("skillListText", () => {
    it("prints a skill's name, source and path on one line", () => {
        const text = skillListText(listing({ skills: [skill({ source: { kind: "path", path: "/team/skills" } })] }));
        assert.equal(text, "review  path /team/skills  /data/skills/review");
    });

    it("prints each shadowed copy on an indented line under the copy in use", () => {
        const text = skillListText(
            listing({
                skills: [
                    skill({
                        source: { kind: "workspace", path: "/ws/.pi/skills" },
                        path: "/ws/.pi/skills/review",
                        shadowed: [
                            { path: "/team/skills/review", source: { kind: "path", path: "/team/skills" } },
                            { path: "/data/skills/review", source: { kind: "internal" } },
                        ],
                    }),
                    skill({ name: "other", path: "/data/skills/other" }),
                ],
            }),
        );
        assert.deepEqual(text.split("\n"), [
            "review  workspace /ws/.pi/skills  /ws/.pi/skills/review",
            "    shadowed: path /team/skills  /team/skills/review",
            "    shadowed: internal  /data/skills/review",
            "other  internal  /data/skills/other",
        ]);
    });

    it("prints enabled, edited and deleted as words", () => {
        const text = skillListText(
            listing({
                skills: [
                    skill({ enabled: true, edited: true }),
                    skill({ name: "gone", path: "/data/skills/gone", enabled: true, edited: true, deleted: true }),
                ],
            }),
        );
        assert.deepEqual(text.split("\n"), [
            "review  internal  /data/skills/review  enabled edited",
            "gone  internal  /data/skills/gone  enabled deleted",
        ]);
    });

    it("prints missing names and left-out paths with the reason", () => {
        const text = skillListText(
            listing({ missing: ["ghost"], leftOut: [{ path: "/team/skills/bad", reason: "no description" }] }),
        );
        assert.deepEqual(text.split("\n"), ["missing: ghost", "left out: /team/skills/bad - no description"]);
    });

    it("prints the seat of a conversation first", () => {
        const text = skillListText(
            listing({ seat: { role: "bob", model: "m", thinkingLevel: "high", workspace: "/ws" }, skills: [skill()] }),
        );
        assert.deepEqual(text.split("\n"), [
            "seat: bob (m, thinking high, workspace /ws)",
            "review  internal  /data/skills/review",
        ]);
    });

    it("prints no description and no more than one line per skill", () => {
        const text = skillListText(listing({ skills: [skill({ description: "line one\nline two" })] }));
        assert.equal(text.split("\n").length, 1);
        assert.doesNotMatch(text, /line one|line two/);
    });

    it("keeps control sequences and line breaks in data off the screen", () => {
        const text = skillListText(
            listing({
                skills: [skill({ name: `a${CLIPBOARD_WRITE}\nforged`, path: `/p\n${ESC}[2J` })],
                missing: [`x${ESC}[31m`],
                leftOut: [{ path: `/q${CLIPBOARD_WRITE}`, reason: `why\nforged left out: z` }],
            }),
        );
        assert.doesNotMatch(text, new RegExp(`${ESC}|${BEL}`));
        assert.equal(text.split("\n").length, 3);
    });

    it("prints nothing for an empty catalog", () => {
        assert.equal(skillListText(listing()), "");
    });
});

describe("searchPathsText", () => {
    it("prints each path, with the reason when the check failed", () => {
        const text = searchPathsText([
            { path: "/a", ok: true },
            { path: `/b${ESC}[2J`, ok: false, reason: "not a folder\nforged" },
        ]);
        assert.deepEqual(text.split("\n"), ["/a", "/b  unusable: not a folder forged"]);
    });
});

describe("instructionListText", () => {
    it("prints shipped, edited and missing as words", () => {
        const text = instructionListText({
            files: [
                { kind: "common", path: "/data/instructions/common.md", shipped: true, edited: true, missing: false },
                { kind: "role", path: "/data/instructions/roles/x.md", shipped: false, edited: false, missing: true },
                { kind: "workspace", path: "/ws/AGENTS.md", shipped: false, edited: false, missing: false },
            ],
        });
        assert.deepEqual(text.split("\n"), [
            "common  /data/instructions/common.md  shipped edited",
            "role  /data/instructions/roles/x.md  missing",
            "workspace  /ws/AGENTS.md",
        ]);
    });
});

describe("skillText", () => {
    it("prints a restored skill as one list line", () => {
        assert.equal(skillText(skill({ enabled: true })), "review  internal  /data/skills/review  enabled");
    });
});
