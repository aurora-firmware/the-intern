import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { HermeticEnv } from "../support/hermetic_env.ts";
import { type SkillsRig, startSkillsRig } from "../support/skills_rig.ts";

const OWNER_ONLY_MODE = 0o700;

/** The `config.toml` text that lists the named owner-only folders under the hermetic root as search paths, lowest first. */
function searchPathsToml(...names: string[]): (dirs: HermeticEnv) => string {
    return (dirs) => {
        const paths = names.map((name) => join(dirs.root, name));
        for (const path of paths) {
            mkdirSync(path, { recursive: true });
            chmodSync(path, OWNER_ONLY_MODE);
        }
        return `[skills]\npaths = [${paths.map((path) => `"${path}"`).join(", ")}]\n`;
    };
}

type Listing = {
    skills: { name: string; path: string; source: { kind: string; path?: string }; shadowed: { path: string }[] }[];
    missing: string[];
    leftOut: unknown[];
    seat?: { role: string; workspace: string };
};

const rigs: SkillsRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function start(options: Parameters<typeof startSkillsRig>[0] = {}): Promise<SkillsRig> {
    const rig = await startSkillsRig(options);
    rigs.push(rig);
    return rig;
}

const refusal = (code: string) => (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === code;

describe("skills.list", () => {
    it("uses the later search path's copy and shadows the earlier path's two", async () => {
        const rig = await start({ configToml: searchPathsToml("a", "b") });
        const first = join(rig.dirs.root, "a");
        const second = join(rig.dirs.root, "b");
        const nested = await rig.writeSkill(join(first, "x"), "lint", "Lint in x.");
        const other = await rig.writeSkill(join(first, "y"), "lint", "Lint in y.");
        const winner = await rig.writeSkill(second, "lint", "Lint in b.");

        const listing = (await rig.invoke("skills.list", { role: "gp" })) as Listing;

        const lint = listing.skills.filter((skill) => skill.name === "lint");
        assert.equal(lint.length, 1);
        assert.equal(lint[0]?.path, winner);
        assert.deepEqual(lint[0]?.shadowed.map(({ path }) => path).sort(), [nested, other].sort());
    });

    it("refuses a call that names both a role and a conversation", async () => {
        const rig = await start();
        const job = (await rig.invoke("jobs.create", { text: "Look around.", role: "gp" })) as {
            leadConversation: string;
        };

        await assert.rejects(
            rig.invoke("skills.list", { role: "gp", conversation: job.leadConversation }),
            refusal("invalid_input"),
        );
    });

    it("refuses a call that names neither", async () => {
        const rig = await start();

        await assert.rejects(rig.invoke("skills.list", {}), refusal("invalid_input"));
    });

    it("refuses an unknown role and an unknown conversation as not found", async () => {
        const rig = await start();

        await assert.rejects(rig.invoke("skills.list", { role: "nobody" }), refusal("not_found"));
        await assert.rejects(rig.invoke("skills.list", { conversation: "0" }), refusal("not_found"));
    });

    it("lists a seated agent's catalog from its seat workspace, with its seat", async () => {
        const rig = await start();
        const job = (await rig.invoke("jobs.create", { text: "Look around.", role: "gp" })) as {
            leadConversation: string;
        };

        const listing = (await rig.invoke("skills.list", { conversation: job.leadConversation })) as Listing;

        assert.equal(listing.seat?.role, "gp");
        assert.equal(listing.seat?.workspace, join(rig.dirs.dataDir, "workspaces", "gp"));
        assert.ok(listing.skills.some((skill) => skill.name === "carry-out-a-part"));
    });
});

const configText = (rig: SkillsRig): string => readFileSync(join(rig.dirs.configDir, "config.toml"), "utf8");

async function seatGp(rig: SkillsRig): Promise<string> {
    const job = (await rig.invoke("jobs.create", { text: "Look around.", role: "gp" })) as { leadConversation: string };
    return job.leadConversation;
}

async function firstPrompt(rig: SkillsRig, conversation: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    for (;;) {
        const [prompt] = await rig.systemPrompts(conversation);
        if (prompt !== undefined) return prompt;
        if (Date.now() > deadline) throw new Error("the conversation made no model request in time");
        await sleep(10);
    }
}

const enabledOf = async (rig: SkillsRig, input: object): Promise<string[]> =>
    ((await rig.invoke("skills.list", input)) as { skills: { name: string; enabled: boolean }[] }).skills
        .filter((skill) => skill.enabled)
        .map((skill) => skill.name);

describe("skills.enable and skills.disable for a role", () => {
    it("lists an enabled skill for the role in config.toml and in the prompt of an agent seated afterwards", async () => {
        const rig = await start({ configToml: searchPathsToml("a") });
        await rig.writeSkill(join(rig.dirs.root, "a"), "code-review", "Review code.");

        const result = (await rig.invoke("skills.enable", { name: "code-review", role: "gp" })) as {
            enabledSkills: string[];
        };

        assert.deepEqual(result.enabledSkills, ["carry-out-a-part", "bob-command-line", "code-review"]);
        assert.match(configText(rig), /\[roles\.gp\]\s+skills = \[[^\]]*"code-review"/);
        const prompt = await firstPrompt(rig, await seatGp(rig));
        assert.match(prompt, /code-review/);
    });

    it("refuses a name the role catalog doesn't hold as not found and leaves config.toml unchanged", async () => {
        const rig = await start();
        const before = configText(rig);

        await assert.rejects(rig.invoke("skills.enable", { name: "no-such-skill", role: "gp" }), refusal("not_found"));

        assert.equal(configText(rig), before);
    });

    it("refuses an unknown role as not found, for enable and for disable", async () => {
        const rig = await start();

        await assert.rejects(
            rig.invoke("skills.enable", { name: "carry-out-a-part", role: "nobody" }),
            refusal("not_found"),
        );
        await assert.rejects(
            rig.invoke("skills.disable", { name: "carry-out-a-part", role: "nobody" }),
            refusal("not_found"),
        );
    });

    it("writes a shipped role's full list of defaults with the change", async () => {
        const rig = await start();

        const result = (await rig.invoke("skills.disable", { name: "bob-command-line", role: "gp" })) as {
            enabledSkills: string[];
        };

        assert.deepEqual(result.enabledSkills, ["carry-out-a-part"]);
        assert.match(configText(rig), /\[roles\.gp\]\s+skills = \[ "carry-out-a-part" \]/);
    });

    it("succeeds and changes nothing when the disabled name isn't in the list", async () => {
        const rig = await start();
        const before = configText(rig);

        const result = (await rig.invoke("skills.disable", { name: "about-the-intern", role: "gp" })) as {
            enabledSkills: string[];
        };

        assert.deepEqual(result.enabledSkills, ["carry-out-a-part", "bob-command-line"]);
        assert.equal(configText(rig), before);
    });

    it("lists a name once when it is enabled twice and writes nothing the second time", async () => {
        const rig = await start({ configToml: searchPathsToml("a") });
        await rig.writeSkill(join(rig.dirs.root, "a"), "code-review", "Review code.");
        await rig.invoke("skills.enable", { name: "code-review", role: "gp" });
        const before = configText(rig);

        const result = (await rig.invoke("skills.enable", { name: "code-review", role: "gp" })) as {
            enabledSkills: string[];
        };

        assert.deepEqual(result.enabledSkills, ["carry-out-a-part", "bob-command-line", "code-review"]);
        assert.equal(configText(rig), before);
    });

    it("refuses with conflict when config.toml changed on disk", async () => {
        const rig = await start({ configToml: searchPathsToml("a") });
        await rig.writeSkill(join(rig.dirs.root, "a"), "code-review", "Review code.");
        writeFileSync(join(rig.dirs.configDir, "config.toml"), `${configText(rig)}\n# edited by hand\n`);

        await assert.rejects(rig.invoke("skills.enable", { name: "code-review", role: "gp" }), refusal("conflict"));
    });

    it("leaves the enabled set of an agent already seated unchanged", async () => {
        const rig = await start({ configToml: searchPathsToml("a") });
        await rig.writeSkill(join(rig.dirs.root, "a"), "code-review", "Review code.");
        const conversation = await seatGp(rig);
        const before = await enabledOf(rig, { conversation });

        await rig.invoke("skills.enable", { name: "code-review", role: "gp" });
        await rig.invoke("skills.disable", { name: "carry-out-a-part", role: "gp" });

        assert.deepEqual(await enabledOf(rig, { conversation }), before);
        const forRole = await enabledOf(rig, { role: "gp" });
        assert.ok(forRole.includes("code-review"));
        assert.ok(!forRole.includes("carry-out-a-part"));
    });
});
