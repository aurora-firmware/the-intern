import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import {
    LEAD_DUTY,
    type PromptParts,
    renderPromptSections,
    renderSkillListing,
    scheduledRunNotice,
} from "../../src/prompt/role_prompt.ts";
import type { CatalogSkill } from "../../src/skills/skill_resolution.ts";

describe("the lead duty and the scheduled run notice", () => {
    it("names the definition of done, the reason, the evidence and the three tools", () => {
        assert.match(LEAD_DUTY, /definition of done/);
        assert.match(LEAD_DUTY, /reason/);
        assert.match(LEAD_DUTY, /evidence/);
        assert.match(LEAD_DUTY, /justification/);
        for (const tool of ["update_job", "block_job", "complete_job"] as const) {
            assert.ok(JOB_TOOL_NAMES.includes(tool), `${tool} is a job tool`);
            assert.ok(LEAD_DUTY.includes(tool), tool);
        }
    });

    it("names the schedule entry, the read schedule runs tool and the earlier scheduled runs", () => {
        const notice = scheduledRunNotice("nightly-backup");
        assert.ok(notice.includes("nightly-backup"));
        assert.ok(notice.includes("read_schedule_runs"));
        assert.ok(JOB_TOOL_NAMES.includes("read_schedule_runs"));
        assert.match(notice, /earlier scheduled runs/i);
    });

    it("builds the same notice for the same entry", () => {
        assert.equal(scheduledRunNotice("nightly"), scheduledRunNotice("nightly"));
        assert.notEqual(scheduledRunNotice("nightly"), scheduledRunNotice("weekly"));
    });

    it("renders the lead duty byte-identically on every request", () => {
        const first = renderPromptSections(makeParts({ isLead: true }));
        const second = renderPromptSections(makeParts({ isLead: true }));
        const dutyOf = (sections: typeof first) => sections.find((section) => section.key === "intern-lead-duty")?.text;
        assert.equal(dutyOf(first), dutyOf(second));
        assert.equal(JSON.stringify(first), JSON.stringify(second));
    });
});

function makeCatalogSkill(name: string, description = `${name} description`): CatalogSkill {
    return {
        name,
        description,
        folder: `/skills/${name}`,
        file: `/skills/${name}/SKILL.md`,
        source: { kind: "internal" },
        shadowed: [],
        shipped: true,
        edited: false,
    };
}

function makeParts(overrides: Partial<PromptParts> = {}): PromptParts {
    return {
        common: "Common text.",
        role: "Write clearly.",
        isLead: true,
        workspace: "/work/space",
        contextFiles: [{ path: "/work/space/AGENTS.md", content: "Be careful." }],
        skills: [makeCatalogSkill("alpha")],
        ...overrides,
    };
}

function keysOf(parts: PromptParts): string[] {
    return renderPromptSections(parts).map((section) => section.key);
}

describe("renderPromptSections", () => {
    it("renders every part in the order common, role, lead duty, workspace context, skills", () => {
        assert.deepEqual(keysOf(makeParts()), [
            "intern-common",
            "intern-role",
            "intern-lead-duty",
            "intern-workspace-context",
            "intern-skills",
        ]);
        const sections = renderPromptSections(makeParts());
        assert.equal(sections[0]?.text, "Common text.");
        assert.equal(sections[1]?.text, "Write clearly.");
        assert.equal(sections[2]?.text, LEAD_DUTY);
        assert.match(sections[3]?.text ?? "", /Your workspace is \/work\/space\./);
        assert.match(sections[3]?.text ?? "", /Be careful\./);
    });

    it("leaves out the common section when the common prompt is missing or empty", () => {
        assert.ok(!keysOf(makeParts({ common: undefined })).includes("intern-common"));
        assert.ok(!keysOf(makeParts({ common: "" })).includes("intern-common"));
    });

    it("leaves out the role section when the role's text is missing or empty", () => {
        assert.ok(!keysOf(makeParts({ role: undefined })).includes("intern-role"));
        assert.ok(!keysOf(makeParts({ role: "" })).includes("intern-role"));
    });

    it("leaves out the lead duty for a member who is not the lead", () => {
        assert.ok(!keysOf(makeParts({ isLead: false })).includes("intern-lead-duty"));
    });

    it("leaves out the skills section when there is no skill", () => {
        assert.ok(!keysOf(makeParts({ skills: [] })).includes("intern-skills"));
    });

    it("returns byte-identical sections for equal parts rendered three times", () => {
        const renders = [1, 2, 3].map(() => JSON.stringify(renderPromptSections(makeParts())));
        assert.equal(renders[1], renders[0]);
        assert.equal(renders[2], renders[0]);
    });

    it("changes only the skills section when one skill is added", () => {
        const before = renderPromptSections(makeParts());
        const after = renderPromptSections(
            makeParts({ skills: [makeCatalogSkill("alpha"), makeCatalogSkill("beta")] }),
        );
        assert.equal(after.length, before.length);
        for (const [index, section] of before.entries()) {
            const other = after[index];
            if (section.key === "intern-skills") {
                assert.notEqual(other?.text, section.text);
            } else {
                assert.deepEqual(other, section);
            }
        }
    });
});

describe("renderSkillListing", () => {
    it("names the skill tool and the file tool in the fixed text", () => {
        const text = renderSkillListing([makeCatalogSkill("alpha")]);
        assert.match(text, /`skill` tool/);
        assert.match(text, /`name`/);
        assert.match(text, /`file`/);
        assert.match(text, /relative to the skill's folder/);
    });

    it("lists each skill by name, description and SKILL.md path", () => {
        const text = renderSkillListing([makeCatalogSkill("alpha", "Does alpha.")]);
        assert.match(text, /<available_skills>/);
        assert.match(
            text,
            /<skill>\n {4}<name>alpha<\/name>\n {4}<description>Does alpha\.<\/description>\n {4}<location>\/skills\/alpha\/SKILL\.md<\/location>\n {2}<\/skill>/,
        );
    });

    it("sorts the skills by name in byte order", () => {
        const text = renderSkillListing(["beta", "Zeta", "alpha", "\u00e9"].map((name) => makeCatalogSkill(name)));
        const names = [...text.matchAll(/<name>(.*?)<\/name>/g)].map((match) => match[1]);
        assert.deepEqual(names, ["Zeta", "alpha", "beta", "\u00e9"]);
    });

    it("escapes the text as pi agent does", () => {
        const text = renderSkillListing([makeCatalogSkill("a", `Use <b> & "q" 'x'`)]);
        assert.match(text, /<description>Use &lt;b&gt; &amp; &quot;q&quot; &apos;x&apos;<\/description>/);
    });
});
