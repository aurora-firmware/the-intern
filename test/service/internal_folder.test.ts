import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Caller } from "../../src/service/operations.ts";
import type { FileChange } from "../../src/skills/file_store.ts";
import { DEFAULT_SHIPPED_ROOT } from "../../src/skills/internal_folder.ts";
import { createSkillsComponent } from "../../src/skills/skills_component.ts";
import type { FakeReply, FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startSkillsRig } from "../support/skills_rig.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_BITS = 0o777;
const CARRY_OUT_SKILL = "skills/carry-out-a-part/SKILL.md";
const ABOUT_SKILL = "skills/about-the-intern/SKILL.md";

const TEAM_MEMBER: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

type Fixture = {
    env: HermeticEnv;
    shippedRoot: string;
    /** Every file change the daemon announced, from the moment it is ready. */
    announced: FileChange[];
    start(): Promise<RunningDaemon>;
};

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const shippedRoot = join(env.root, "shipped");
    await cp(DEFAULT_SHIPPED_ROOT, shippedRoot, { recursive: true });
    const logger = createLogger({ verbose: false, stream: { write: () => true } });
    const announced: FileChange[] = [];
    return {
        env,
        shippedRoot,
        announced,
        async start() {
            const skills = createSkillsComponent({ logger, shippedRoot });
            // No agents component runs here, so a stub stands in for the role catalog `skills.restore` asks.
            skills.connectAgents(() => ({ catalog: { list: () => [] } }) as never);
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: env.env,
                homeDir: env.root,
                logger,
                sections: skills.sections,
                components: [
                    skills.component,
                    {
                        name: "announcements",
                        checkModels: async (ctx) => void ctx.fileChanges.onChange((change) => announced.push(change)),
                    },
                ],
                operations: skills.operations,
            });
            daemons.push(daemon);
            await until(() => daemon.phase() === "ready", "the daemon to be ready");
            return daemon;
        },
    };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function restart(daemon: RunningDaemon, fixture: { start(): Promise<RunningDaemon> }): Promise<RunningDaemon> {
    await daemon.stop();
    return fixture.start();
}

async function modeOf(path: string): Promise<number> {
    return (await stat(path)).mode & MODE_BITS;
}

async function filesUnder(root: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        found[path.slice(root.length + 1)] = await readFile(path, "utf8");
    }
    return found;
}

describe("the internal folder at startup", () => {
    it("creates instructions and skills owner-only with the shipped text on an empty data directory", async () => {
        const fixture = await createFixture();

        await fixture.start();

        const shipped = await filesUnder(fixture.shippedRoot);
        const names = Object.keys(shipped);
        assert.ok(names.includes("instructions/common.md"));
        assert.ok(names.includes(CARRY_OUT_SKILL));
        for (const [name, text] of Object.entries(shipped)) {
            const path = join(fixture.env.dataDir, name);
            assert.equal(await readFile(path, "utf8"), text);
            assert.equal(await modeOf(path), FILE_MODE, `${name} mode`);
        }
        for (const folder of ["instructions", "instructions/roles", "skills", "skills/carry-out-a-part"]) {
            assert.equal(await modeOf(join(fixture.env.dataDir, folder)), FOLDER_MODE, `${folder} mode`);
        }
    });

    it("keeps a hand edit of a skill across a restart and leaves the shipped root unchanged", async () => {
        const fixture = await createFixture();
        const daemon = await fixture.start();
        const shippedBefore = await filesUnder(fixture.shippedRoot);
        const edited = join(fixture.env.dataDir, CARRY_OUT_SKILL);
        await writeFile(edited, "my own text\n");

        await restart(daemon, fixture);

        assert.equal(await readFile(edited, "utf8"), "my own text\n");
        assert.deepEqual(await filesUnder(fixture.shippedRoot), shippedBefore);
    });

    it("holds new shipped text for an unedited file and keeps an edited one", async () => {
        const fixture = await createFixture();
        const daemon = await fixture.start();
        const roles = join(fixture.env.dataDir, "instructions/roles");
        await writeFile(join(roles, "bob.md"), "edited bob\n");
        await writeFile(join(fixture.shippedRoot, "instructions/roles/gp.md"), "new gp\n");
        await writeFile(join(fixture.shippedRoot, "instructions/roles/bob.md"), "new bob\n");

        await restart(daemon, fixture);

        assert.equal(await readFile(join(roles, "gp.md"), "utf8"), "new gp\n");
        assert.equal(await readFile(join(roles, "bob.md"), "utf8"), "edited bob\n");
    });

    it("leaves a deleted shipped skill absent after a restart", async () => {
        const fixture = await createFixture();
        await mkdir(join(fixture.shippedRoot, "skills/about-the-intern"), { recursive: true });
        await writeFile(join(fixture.shippedRoot, ABOUT_SKILL), "---\nname: about-the-intern\n---\nAbout.\n");
        const daemon = await fixture.start();
        const skill = join(fixture.env.dataDir, "skills/about-the-intern");
        assert.equal((await stat(skill)).isDirectory(), true);
        await rm(skill, { recursive: true });

        await restart(daemon, fixture);

        await assert.rejects(stat(skill), { code: "ENOENT" });
    });

    it("knows the data directory only once startup step 3 has run", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const logger = createLogger({ verbose: false, stream: { write: () => true } });
        const skills = createSkillsComponent({ logger });
        assert.throws(() => skills.dataDir(), /before startup step 3/);

        await skills.component.prepareFiles?.({
            dirs: { dataDir: env.dataDir, runtimeDir: env.runtimeDir } as never,
            config: { values: new Map() } as never,
            logger,
        });

        assert.equal(skills.dataDir(), env.dataDir);
    });
});

describe("instructions.list after a restart", () => {
    it("marks an edited shipped role file as edited and leaves the common prompt unmarked", async () => {
        const rig = await startSkillsRig();
        try {
            await writeFile(join(rig.dirs.dataDir, "instructions/roles/bob.md"), "edited bob\n");

            await rig.restart();

            const { files } = (await rig.invoke("instructions.list", { role: "bob" })) as {
                files: { kind: string; edited: boolean }[];
            };
            assert.deepEqual(
                files.filter(({ kind }) => kind !== "workspace").map(({ kind, edited }) => ({ kind, edited })),
                [
                    { kind: "common", edited: false },
                    { kind: "role", edited: true },
                ],
            );
        } finally {
            await rig.stop();
        }
    });
});

type ListedSkill = { name: string; edited: boolean; shipped: boolean; deleted?: true };

const listedSkill = async (rig: Awaited<ReturnType<typeof startSkillsRig>>, name: string) =>
    ((await rig.invoke("skills.list", { role: "bob" })) as { skills: ListedSkill[] }).skills.find(
        (skill) => skill.name === name,
    );

/** A copy of the installed shipped text that also holds the `about-the-intern` skill. */
async function shippedRootWithAboutSkill(): Promise<{ env: HermeticEnv; shippedRoot: string }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const shippedRoot = join(env.root, "shipped");
    await cp(DEFAULT_SHIPPED_ROOT, shippedRoot, { recursive: true });
    await mkdir(join(shippedRoot, "skills/about-the-intern"), { recursive: true });
    await writeFile(
        join(shippedRoot, ABOUT_SKILL),
        "---\nname: about-the-intern\ndescription: About.\n---\nShipped about text.\n",
    );
    return { env, shippedRoot };
}

describe("skills.restore", () => {
    it("brings back a deleted shipped skill with the shipped text, listed as not edited", async () => {
        const { shippedRoot } = await shippedRootWithAboutSkill();
        const rig = await startSkillsRig({ shippedRoot });
        try {
            const skill = join(rig.dirs.dataDir, "skills/about-the-intern");
            await rm(skill, { recursive: true });
            await rig.restart();
            assert.equal((await listedSkill(rig, "about-the-intern"))?.deleted, true);

            const restored = (await rig.invoke("skills.restore", { name: "about-the-intern" })) as ListedSkill;

            assert.equal(
                await readFile(join(skill, "SKILL.md"), "utf8"),
                await readFile(join(shippedRoot, ABOUT_SKILL), "utf8"),
            );
            assert.deepEqual(restored, await listedSkill(rig, "about-the-intern"));
            assert.deepEqual(
                { shipped: restored.shipped, edited: restored.edited, deleted: restored.deleted },
                { shipped: true, edited: false, deleted: undefined },
            );
        } finally {
            await rig.stop();
        }
    });

    it("refuses a skill that isn't shipped as not found", async () => {
        const rig = await startSkillsRig();
        try {
            for (const name of ["no-such-skill", "../instructions", ".."]) {
                await assert.rejects(rig.invoke("skills.restore", { name }), { code: "not_found" });
            }
        } finally {
            await rig.stop();
        }
    });

    it("announces files_changed with kind skill for each restored skill file", async () => {
        const fixture = await createFixture();
        await rm(join(fixture.shippedRoot, "skills/about-the-intern"), { recursive: true, force: true });
        await mkdir(join(fixture.shippedRoot, "skills/about-the-intern/notes"), { recursive: true });
        await writeFile(
            join(fixture.shippedRoot, ABOUT_SKILL),
            "---\nname: about-the-intern\ndescription: About.\n---\nAbout.\n",
        );
        await writeFile(join(fixture.shippedRoot, "skills/about-the-intern/notes/more.md"), "More.\n");
        const daemon = await fixture.start();
        fixture.announced.length = 0;

        await daemon.catalogue.invoke("skills.restore", { name: "about-the-intern" }, TEAM_MEMBER);

        const folder = join(fixture.env.dataDir, "skills/about-the-intern");
        assert.deepEqual(
            fixture.announced.toSorted((left, right) => left.path.localeCompare(right.path)),
            [
                { path: join(folder, "SKILL.md"), kind: "skill" },
                { path: join(folder, "notes/more.md"), kind: "skill" },
            ].toSorted((left, right) => left.path.localeCompare(right.path)),
        );
    });
});

describe("instructions.restore", () => {
    it("announces one files_changed delta naming the role file and kind role", async () => {
        const fixture = await createFixture();
        const daemon = await fixture.start();
        const file = join(fixture.env.dataDir, "instructions/roles/gp.md");
        await writeFile(file, "edited gp\n");
        fixture.announced.length = 0;

        await daemon.catalogue.invoke("instructions.restore", { name: "gp" }, TEAM_MEMBER);

        assert.deepEqual(fixture.announced, [{ path: file, kind: "role" }]);
    });

    it("announces kind common for the common prompt", async () => {
        const fixture = await createFixture();
        const daemon = await fixture.start();
        fixture.announced.length = 0;

        await daemon.catalogue.invoke("instructions.restore", { name: "common" }, TEAM_MEMBER);

        assert.deepEqual(fixture.announced, [
            { path: join(fixture.env.dataDir, "instructions/common.md"), kind: "common" },
        ]);
    });
});

describe("an edited skill file after a restart", () => {
    it("is the text a gp agent's skill call returns", async () => {
        const toolResults: string[] = [];
        const reply = (transcript: FakeTranscript): FakeReply => {
            const last = transcript.at(-1);
            if (last?.role === "toolResult") {
                toolResults.push(last.text);
                return "ok";
            }
            if (last?.text === "use it")
                return { toolCall: { name: "skill", arguments: { name: "carry-out-a-part" } } };
            return "ok";
        };
        const rig = await startSkillsRig({ reply });
        try {
            await writeFile(
                join(rig.dirs.dataDir, CARRY_OUT_SKILL),
                "---\nname: carry-out-a-part\ndescription: Carry.\n---\nHand-edited carry text.\n",
            );

            await rig.restart();
            const job = (await rig.invoke("jobs.create", { text: "begin", role: "gp" })) as {
                leadConversation: string;
            };
            await until(async () => (await rig.systemPrompts(job.leadConversation)).length > 0, "the first request");
            await rig.invoke("conversations.submit", {
                conversationId: job.leadConversation,
                content: "use it",
                requestId: "use-it",
            });
            await until(() => toolResults.length > 0, "the skill tool result");

            assert.match(toolResults[0] as string, /Hand-edited carry text\./);
        } finally {
            await rig.stop();
        }
    });
});
