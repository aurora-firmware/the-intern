import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
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
