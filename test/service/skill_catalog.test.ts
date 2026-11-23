import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { HermeticEnv } from "../support/hermetic_env.ts";
import { type SkillsRig, startSkillsRig } from "../support/skills_rig.ts";

const OWNER_ONLY_MODE = 0o700;

type Source = { kind: string; path?: string };
type Listed = {
    name: string;
    description: string;
    source: Source;
    path: string;
    enabled: boolean;
    shipped: boolean;
    edited: boolean;
    deleted?: boolean;
    shadowed: { path: string; source: Source }[];
};
type Listing = { skills: Listed[]; missing: string[]; leftOut: { path: string; reason: string }[] };

/** The `config.toml` text that lists the named owner-only folders under the hermetic root as search paths, lowest first. */
function searchPathsToml(names: string[], extra = ""): (dirs: HermeticEnv) => string {
    return (dirs) => {
        const paths = names.map((name) => join(dirs.root, name));
        for (const path of paths) {
            mkdirSync(path, { recursive: true });
            chmodSync(path, OWNER_ONLY_MODE);
        }
        return `[skills]\npaths = [${paths.map((path) => `"${path}"`).join(", ")}]\n${extra}`;
    };
}

const rigs: SkillsRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function start(options: Parameters<typeof startSkillsRig>[0] = {}): Promise<SkillsRig> {
    const rig = await startSkillsRig(options);
    rigs.push(rig);
    return rig;
}

const listRole = async (rig: SkillsRig, role: string): Promise<Listing> =>
    (await rig.invoke("skills.list", { role })) as Listing;

const named = (listing: Listing, name: string): Listed => {
    const found = listing.skills.find((skill) => skill.name === name);
    assert.ok(found, `${name} is listed`);
    return found;
};

describe("the skills catalog of a role", () => {
    it("lists the default skills of the desk and gp roles on a fresh instance (AC-001.1)", async () => {
        const rig = await start();
        const skillsFolder = join(rig.dirs.dataDir, "skills");

        const desk = await listRole(rig, "desk");
        const gp = await listRole(rig, "gp");

        const about = named(desk, "about-the-intern");
        assert.equal(about.enabled, true);
        assert.equal(about.path, join(skillsFolder, "about-the-intern"));
        for (const name of ["carry-out-a-part", "bob-command-line"]) {
            const skill = named(gp, name);
            assert.equal(skill.enabled, true);
            assert.equal(skill.path, join(skillsFolder, name));
        }
    });

    it("lists the workspace copy in use and the search path and internal copies as shadowed", async () => {
        const rig = await start({ configToml: searchPathsToml(["team-skills"]) });
        const teamSkills = join(rig.dirs.root, "team-skills");
        const workspace = join(rig.dirs.dataDir, "workspaces", "gp");
        const pathCopy = await rig.writeSkill(teamSkills, "carry-out-a-part", "The team's copy.");
        const workspaceCopy = await rig.writeSkill(join(workspace, ".pi", "skills"), "carry-out-a-part", "Mine.");

        const skill = named(await listRole(rig, "gp"), "carry-out-a-part");

        assert.equal(skill.path, workspaceCopy);
        assert.deepEqual(skill.source, { kind: "workspace", path: join(workspace, ".pi", "skills") });
        assert.equal(skill.enabled, true);
        assert.deepEqual(
            skill.shadowed.map(({ path }) => path).sort(),
            [pathCopy, join(rig.dirs.dataDir, "skills", "carry-out-a-part")].sort(),
        );
        assert.deepEqual(skill.shadowed.map(({ source }) => source.kind).sort(), ["internal", "path"]);
    });

    it("lists a valid skill and leaves out one with no description, with the reason", async () => {
        const rig = await start({ configToml: searchPathsToml(["team-skills"]) });
        const teamSkills = join(rig.dirs.root, "team-skills");
        await rig.writeSkill(teamSkills, "valid-one", "A valid skill.");
        await mkdir(join(teamSkills, "bare"));
        await writeFile(join(teamSkills, "bare", "SKILL.md"), "---\nname: bare\n---\n\nNo description.\n");

        const listing = await listRole(rig, "gp");

        assert.equal(named(listing, "valid-one").description, "A valid skill.");
        assert.equal(
            listing.skills.some((skill) => skill.name === "bare"),
            false,
        );
        assert.deepEqual(listing.leftOut, [
            { path: join(teamSkills, "bare", "SKILL.md"), reason: "description is required" },
        ]);
    });

    it("reports ready and lists an enabled skill whose folder was deleted as missing", async () => {
        const rig = await start({
            configToml: searchPathsToml(
                ["team-skills"],
                '\n[roles.gp]\nskills = ["carry-out-a-part", "code-review"]\n',
            ),
        });
        const folder = await rig.writeSkill(join(rig.dirs.root, "team-skills"), "code-review", "Review code.");
        assert.deepEqual((await listRole(rig, "gp")).missing, []);
        await rm(folder, { recursive: true });

        await rig.restart();

        const listing = await listRole(rig, "gp");
        assert.deepEqual(listing.missing, ["code-review"]);
        assert.equal(named(listing, "carry-out-a-part").enabled, true);
    });

    it("lists a deleted shipped skill as edited and deleted", async () => {
        const rig = await start();
        const folder = join(rig.dirs.dataDir, "skills", "carry-out-a-part");
        await rm(folder, { recursive: true });

        await rig.restart();

        const skill = named(await listRole(rig, "gp"), "carry-out-a-part");
        assert.equal(skill.deleted, true);
        assert.equal(skill.edited, true);
        assert.equal(skill.shipped, true);
        assert.equal(skill.path, folder);
    });
});
