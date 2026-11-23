import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_SHIPPED_ROOT } from "../../src/skills/internal_folder.ts";
import { type SkillsRig, startSkillsRig } from "../support/skills_rig.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const POLL_MS = 10;

const rigs: SkillsRig[] = [];
const roots: string[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function start(options?: Parameters<typeof startSkillsRig>[0]): Promise<SkillsRig> {
    const rig = await startSkillsRig(options);
    rigs.push(rig);
    return rig;
}

async function untilPrompts(rig: SkillsRig, conversationId: string, count: number): Promise<string[]> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const prompts = await rig.systemPrompts(conversationId);
        if (prompts.length >= count) return prompts;
        if (Date.now() > deadline) throw new Error("the conversation made no model request in time");
        await sleep(POLL_MS);
    }
}

async function seatGp(rig: SkillsRig): Promise<string> {
    const job = (await rig.invoke("jobs.create", { text: "Look around.", role: "gp" })) as { leadConversation: string };
    return job.leadConversation;
}

describe("the skills rig", () => {
    it("answers operations as a team member and finds the system text of a seated gp agent", async () => {
        const rig = await start();

        const conversationId = await seatGp(rig);
        const [prompt] = await untilPrompts(rig, conversationId, 1);

        assert.ok(prompt && prompt.length > 0, "the request carried system text");
        assert.deepEqual(await rig.systemPrompts("0"), [], "another conversation has none");
    });

    it("records each request's system text under its own conversation", async () => {
        const rig = await start();

        const first = await seatGp(rig);
        const second = await seatGp(rig);
        await untilPrompts(rig, first, 1);
        await untilPrompts(rig, second, 1);

        assert.notEqual(first, second);
        assert.equal((await rig.systemPrompts(first)).length, 1);
        assert.equal((await rig.systemPrompts(second)).length, 1);
    });

    it("answers with the replies it is given", async () => {
        const rig = await start({ reply: () => "from the rig" });

        const conversationId = await seatGp(rig);
        await untilPrompts(rig, conversationId, 1);

        const deadline = Date.now() + WAIT_MS;
        for (;;) {
            const entries = JSON.stringify(await rig.invoke("conversations.entries", { conversationId }));
            if (entries.includes("from the rig")) break;
            if (Date.now() > deadline) throw new Error("the reply did not reach the conversation");
            await sleep(POLL_MS);
        }
    });

    it("reads the shipped text from the shipped root it is given", async () => {
        const root = await mkdtemp(join(tmpdir(), "bob-shipped-"));
        roots.push(root);
        await cp(DEFAULT_SHIPPED_ROOT, root, { recursive: true });
        await writeFile(join(root, "instructions", "roles", "gp.md"), "SHIPPED-ROOT-MARKER\n");
        const rig = await start({ shippedRoot: root });

        const conversationId = await seatGp(rig);
        const [prompt] = await untilPrompts(rig, conversationId, 1);

        assert.match(prompt ?? "", /SHIPPED-ROOT-MARKER/);
    });

    it("writes a skill and an owner-only folder for a test", async () => {
        const rig = await start();
        const folder = await rig.ownerOnlyFolder(join(rig.dirs.root, "research"));

        assert.equal((await stat(folder)).mode & 0o777, 0o700);
        const skillDir = await rig.writeSkill(folder, "scout", "Scouts ahead.");
        const text = await readFile(join(skillDir, "SKILL.md"), "utf8");
        assert.match(text, /^---\nname: scout\ndescription: Scouts ahead\.\n---\n/);
    });

    it("restarts on the same directories with the configuration it is given", async () => {
        const rig = await start({ configToml: "" });
        const conversationId = await seatGp(rig);
        await untilPrompts(rig, conversationId, 1);
        const { configDir, dataDir } = rig.dirs;

        const searchPath = await rig.ownerOnlyFolder(join(rig.dirs.root, "extra-skills"));
        await rig.restart(`[skills]\npaths = ["${searchPath}"]\n`);

        assert.deepEqual([rig.dirs.configDir, rig.dirs.dataDir], [configDir, dataDir]);
        assert.match(await readFile(join(configDir, "config.toml"), "utf8"), /extra-skills/);
        const listed = (await rig.invoke("conversations.list", {})) as { id?: string; conversationId?: string }[];
        assert.ok(listed.some((entry) => (entry.id ?? entry.conversationId) === conversationId));
    });
});
