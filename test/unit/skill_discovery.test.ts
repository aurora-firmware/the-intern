import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverSkills } from "../../src/skills/skill_discovery.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bob-skill-discovery-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function put(relative: string, text: string): Promise<string> {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return path;
}

const skillText = (description: string, name?: string) =>
    `---\n${name === undefined ? "" : `name: ${name}\n`}description: ${description}\n---\nBody\n`;

describe("discoverSkills", () => {
    it("returns the source folder as the one skill when it holds SKILL.md", async () => {
        const file = await put("SKILL.md", skillText("Does alpha", "alpha"));
        await put("inner/SKILL.md", skillText("Inner"));

        const scan = await discoverSkills(root);

        assert.deepEqual(scan, {
            skills: [{ name: "alpha", description: "Does alpha", folder: root, file }],
            leftOut: [],
            diagnostics: [],
            missing: false,
        });
    });

    it("uses the folder's name when the frontmatter has no name", async () => {
        await put("beta/SKILL.md", skillText("Does beta"));

        const scan = await discoverSkills(root);

        assert.deepEqual(
            scan.skills.map((skill) => skill.name),
            ["beta"],
        );
    });

    it("finds skills at different depths in byte order and does not look inside a skill's folder", async () => {
        await put("b/SKILL.md", skillText("B"));
        await put("b/nested/SKILL.md", skillText("Nested in a skill"));
        await put("a/deep/er/SKILL.md", skillText("Deep"));
        await put("Z/SKILL.md", skillText("Upper"));
        await put("notes/readme.md", skillText("A file is no skill"));

        const scan = await discoverSkills(root);

        assert.deepEqual(
            scan.skills.map((skill) => skill.name),
            ["Z", "er", "b"],
        );
        assert.deepEqual(scan.leftOut, []);
    });

    it("leaves out a SKILL.md that can't be parsed or has no description and returns the others", async () => {
        const broken = await put("broken/SKILL.md", "---\nname: [unclosed\n---\n");
        const empty = await put("empty/SKILL.md", "---\ndescription: '  '\n---\n");
        const missing = await put("none/SKILL.md", "no frontmatter\n");
        await put("ok/SKILL.md", skillText("Fine"));

        const scan = await discoverSkills(root);

        assert.deepEqual(
            scan.skills.map((skill) => skill.name),
            ["ok"],
        );
        assert.deepEqual(
            scan.leftOut.map((entry) => entry.path),
            [broken, empty, missing],
        );
        for (const entry of scan.leftOut) {
            assert.notEqual(entry.reason, "");
        }
        assert.match(scan.leftOut[1]?.reason ?? "", /description/);
    });

    it("leaves out a SKILL.md that can't be read", async () => {
        await mkdir(join(root, "dirskill", "SKILL.md"), { recursive: true });

        const scan = await discoverSkills(root);

        assert.deepEqual(scan.skills, []);
        assert.equal(scan.leftOut.length, 1);
        assert.equal(scan.leftOut[0]?.path, join(root, "dirskill", "SKILL.md"));
    });

    it("keeps a skill whose name breaks the name rule, with a diagnostic", async () => {
        await put("odd/SKILL.md", skillText("Odd", "Bad_Name"));

        const scan = await discoverSkills(root);

        assert.deepEqual(
            scan.skills.map((skill) => skill.name),
            ["Bad_Name"],
        );
        assert.equal(scan.diagnostics.length, 1);
        assert.match(scan.diagnostics[0] ?? "", /Bad_Name/);
    });

    it("ignores every field other than name and description", async () => {
        await put("gamma/SKILL.md", "---\ndescription: G\ndisable-model-invocation: true\nlicense: MIT\n---\n");

        const scan = await discoverSkills(root);

        assert.deepEqual(
            scan.skills.map((skill) => skill.description),
            ["G"],
        );
    });

    it("follows a symbolic link to a folder and visits each real folder once when links form a cycle", async () => {
        await put("real/SKILL.md", skillText("Real", "real"));
        await put("group/one/SKILL.md", skillText("One"));
        await symlink(root, join(root, "group", "loop"), "dir");
        await symlink(join(root, "real"), join(root, "group", "alias"), "dir");

        const scan = await discoverSkills(root);

        assert.deepEqual(
            scan.skills.map((skill) => skill.name),
            ["real", "one"],
        );
    });

    it("returns nothing and missing when the source does not exist", async () => {
        const scan = await discoverSkills(join(root, "absent"));

        assert.deepEqual(scan, { skills: [], leftOut: [], diagnostics: [], missing: true });
    });

    it("returns an added and a removed skill folder at the second call", async () => {
        await put("first/SKILL.md", skillText("First"));
        const before = await discoverSkills(root);

        await put("second/SKILL.md", skillText("Second"));
        await rm(join(root, "first"), { recursive: true });
        const after = await discoverSkills(root);

        assert.deepEqual(
            before.skills.map((skill) => skill.name),
            ["first"],
        );
        assert.deepEqual(
            after.skills.map((skill) => skill.name),
            ["second"],
        );
    });
});
