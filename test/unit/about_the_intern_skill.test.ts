import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPOSITORY = join(import.meta.dirname, "..", "..");
const SKILL_FOLDER = join(REPOSITORY, "src", "shipped", "skills", "about-the-intern");
const MANUAL_FOLDER = join(REPOSITORY, "docs", "manual");

/** The problems of a skill folder's copied manual pages, each naming the page; empty when the skill is in step. */
async function problemsOf(skillFolder: string, manualFolder: string): Promise<string[]> {
    const skillText = await readFile(join(skillFolder, "SKILL.md"), "utf8");
    const pages = (await readdir(join(skillFolder, "manual"))).filter((name) => name.endsWith(".md")).sort();
    const problems: string[] = [];
    for (const page of pages) {
        const original = await readFile(join(manualFolder, page)).catch(() => undefined);
        if (original === undefined) {
            problems.push(`${page}: no longer exists in docs/manual`);
        } else if (!original.equals(await readFile(join(skillFolder, "manual", page)))) {
            problems.push(`${page}: the copy differs from docs/manual/${page}`);
        }
        if (!skillText.includes(page)) problems.push(`${page}: SKILL.md doesn't name it`);
    }
    return problems;
}

describe("the shipped about-the-intern skill", () => {
    it("is in step with the manual pages it draws from", async () => {
        assert.deepEqual(await problemsOf(SKILL_FOLDER, MANUAL_FOLDER), []);
    });

    it("copies the pages that cover the whole product", async () => {
        const pages = await readdir(join(SKILL_FOLDER, "manual"));
        for (const page of [
            "skills_and_instructions.md",
            "roles_and_agents.md",
            "commands.md",
            "web_interface.md",
            "running_the_intern.md",
            "schedules.md",
            "jobs.md",
            "front_desk.md",
        ]) {
            assert.ok(pages.includes(page), `${page} is copied`);
        }
    });

    it("names the skill and describes it in its frontmatter", async () => {
        const text = await readFile(join(SKILL_FOLDER, "SKILL.md"), "utf8");
        assert.match(text, /^---\n\nname: about-the-intern\ndescription: .+\n---\n/);
    });
});

describe("the check of a skill against the manual", () => {
    let root: string;
    let skill: string;
    let manual: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "about-skill-"));
        skill = join(root, "skill");
        manual = join(root, "manual");
        await mkdir(join(skill, "manual"), { recursive: true });
        await mkdir(manual);
        await writeFile(join(manual, "jobs.md"), "# Jobs\n");
        await writeFile(join(skill, "manual", "jobs.md"), "# Jobs\n");
        await writeFile(join(skill, "SKILL.md"), "Read jobs.md for jobs.\n");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("finds nothing when the copy matches and SKILL.md names the page", async () => {
        assert.deepEqual(await problemsOf(skill, manual), []);
    });

    it("names the page when its copy differs from the manual", async () => {
        await writeFile(join(manual, "jobs.md"), "# Jobs, changed\n");
        assert.deepEqual(await problemsOf(skill, manual), ["jobs.md: the copy differs from docs/manual/jobs.md"]);
    });

    it("names the page when it no longer exists in the manual", async () => {
        await rm(join(manual, "jobs.md"));
        assert.deepEqual(await problemsOf(skill, manual), ["jobs.md: no longer exists in docs/manual"]);
    });

    it("names the page when SKILL.md doesn't name it", async () => {
        await writeFile(join(skill, "SKILL.md"), "Nothing here.\n");
        assert.deepEqual(await problemsOf(skill, manual), ["jobs.md: SKILL.md doesn't name it"]);
    });
});
