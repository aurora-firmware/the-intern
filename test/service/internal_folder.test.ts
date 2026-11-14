import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { DEFAULT_SHIPPED_ROOT } from "../../src/skills/internal_folder.ts";
import { createSkillsComponent } from "../../src/skills/skills_component.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_BITS = 0o777;
const CARRY_OUT_SKILL = "skills/carry-out-a-part/SKILL.md";
const ABOUT_SKILL = "skills/about-the-intern/SKILL.md";

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

async function createFixture(): Promise<{ env: HermeticEnv; shippedRoot: string; start(): Promise<RunningDaemon> }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const shippedRoot = join(env.root, "shipped");
    await cp(DEFAULT_SHIPPED_ROOT, shippedRoot, { recursive: true });
    const logger = createLogger({ verbose: false, stream: { write: () => true } });
    return {
        env,
        shippedRoot,
        async start() {
            const skills = createSkillsComponent({ logger, shippedRoot });
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
                components: [skills.component],
                operations: skills.operations,
            });
            daemons.push(daemon);
            await until(() => daemon.phase() === "ready", "the daemon to be ready");
            return daemon;
        },
    };
}

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!condition()) {
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
