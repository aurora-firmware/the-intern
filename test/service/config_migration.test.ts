/** An older role's instructions become its instruction file at startup (S-008 REQ-011: AC-011.1, the instructions half). */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { loadConfig } from "../../src/config/config_file.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { rolesSection } from "../../src/roles/roles_section.ts";
import { migrateOlderKeys } from "../../src/skills/config_migration.ts";
import { createFileStore } from "../../src/skills/file_store.ts";
import {
    DEFAULT_SHIPPED_ROOT,
    prepareInternalFolder,
    roleInstructionPath,
    shippedFileStates,
} from "../../src/skills/internal_folder.ts";
import { skillsSection } from "../../src/skills/skills_section.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

async function startWith(configText: string | ((env: HermeticEnv) => Promise<string>)) {
    const env = await createHermeticEnv();
    envs.push(env);
    const configFile = join(env.configDir, "config.toml");
    await writeFile(configFile, typeof configText === "string" ? configText : await configText(env));
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component],
        operations: agents.operations,
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return { env, agents, configFile, read: () => readFile(configFile, "utf8") };
}

async function makeSkill(root: string, name: string, owner = 0o700): Promise<string> {
    const folder = join(root, "skills", name);
    await mkdir(folder, { recursive: true });
    await chmod(folder, owner);
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`);
    return folder;
}

async function migrateText(configText: string, prepare: (root: string) => Promise<unknown> = async () => {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    await prepare(env.root);
    const configFile = join(env.configDir, "config.toml");
    await writeFile(configFile, configText.replaceAll("$ROOT", env.root));
    const sections = [skillsSection, rolesSection];
    const config = await loadConfig(configFile, sections);
    const store = createFileStore();
    await prepareInternalFolder({ dataDir: env.dataDir, shippedRoot: DEFAULT_SHIPPED_ROOT, store });
    const original = await readFile(configFile, "utf8");
    return {
        env,
        configFile,
        original,
        run: () => migrateOlderKeys({ dirs: { configFile, dataDir: env.dataDir } as never, config, sections, store }),
    };
}

describe("converting an older role's skill paths at startup", () => {
    it("converts a path into the skill's name and adds its folder, keeping the sibling out of the catalog (AC-1, AC-2)", async () => {
        const started = await startWith(async (env) => {
            const folder = await makeSkill(env.root, "code-review");
            await makeSkill(env.root, "carry-out-a-part");
            return `[roles.reviewer]\ninstructions = "Review."\ntools = ["read"]\nskills = ["${folder}"]\n\n[roles.gp]\nskills = ["carry-out-a-part", "${folder}"]\n`;
        });

        const folder = join(started.env.root, "skills", "code-review");
        const text = await started.read();
        assert.match(text, new RegExp(`\\[skills\\]\\npaths = \\[ "${folder}" \\]`));
        assert.equal(text.includes(join(started.env.root, "skills", "carry-out-a-part")), false);
        const reviewer = started.agents.runtime().catalog.seatFor("reviewer");
        assert.deepEqual(reviewer.skills, ["code-review"]);
        assert.equal(await readFile(roleInstructionPath(started.env.dataDir, "reviewer"), "utf8"), "Review.");
        assert.deepEqual(started.agents.runtime().catalog.seatFor("gp").skills, ["carry-out-a-part", "code-review"]);
    });

    it("adds each folder after the existing paths and only once (AC-1)", async () => {
        const migration = await migrateText(
            '[skills]\npaths = ["$ROOT/skills/existing"]\n\n[roles.reviewer]\ntools = ["read"]\nskills = ["$ROOT/skills/code-review"]\n\n[roles.other]\ntools = ["read"]\nskills = ["$ROOT/skills/code-review"]\n',
            async (root) => {
                await makeSkill(root, "existing");
                await makeSkill(root, "code-review");
            },
        );

        const converted = await migration.run();

        assert.deepEqual(converted?.values.get("skills"), {
            paths: [`${migration.env.root}/skills/existing`, `${migration.env.root}/skills/code-review`],
        });
    });

    it("stops naming the role and the path when the folder can be read by other accounts, leaving the file unchanged (AC-3)", async () => {
        const migration = await migrateText(
            '[roles.reviewer]\ninstructions = "Review."\ntools = ["read"]\nskills = ["$ROOT/skills/open"]\n',
            async (root) => {
                await makeSkill(root, "open", 0o755);
            },
        );

        await assert.rejects(migration.run(), (error: Error) => {
            assert.match(error.message, /reviewer/);
            assert.ok(error.message.includes(`${migration.env.root}/skills/open`), error.message);
            assert.match(error.message, /accessible only to the service account/);
            return true;
        });

        assert.equal(await readFile(migration.configFile, "utf8"), migration.original);
        await assert.rejects(readFile(roleInstructionPath(migration.env.dataDir, "reviewer")), /ENOENT/);
    });

    it("stops naming the role and the path when two folders give the same skill name, leaving the file unchanged (AC-4)", async () => {
        const migration = await migrateText(
            '[roles.reviewer]\ntools = ["read"]\nskills = ["$ROOT/one/skills/code-review"]\n\n[roles.other]\ntools = ["read"]\nskills = ["$ROOT/two/skills/code-review"]\n',
            async (root) => {
                await makeSkill(join(root, "one"), "code-review");
                await makeSkill(join(root, "two"), "code-review");
            },
        );

        await assert.rejects(migration.run(), (error: Error) => {
            assert.match(error.message, /other/);
            assert.ok(error.message.includes(`${migration.env.root}/two/skills/code-review`), error.message);
            return true;
        });

        assert.equal(await readFile(migration.configFile, "utf8"), migration.original);
    });

    for (const [label, prepare] of [
        [
            "holds no SKILL.md",
            async (root: string) => mkdir(join(root, "skills", "bare"), { recursive: true, mode: 0o700 }),
        ],
        [
            "holds several skills",
            async (root: string) => {
                await makeSkill(join(root, "skills", "bare"), "one");
                await makeSkill(join(root, "skills", "bare"), "two");
            },
        ],
        ["doesn't exist", async () => {}],
    ] as const) {
        it(`stops naming the role and the path when the folder ${label}, leaving the file unchanged (AC-5)`, async () => {
            const migration = await migrateText(
                '[roles.reviewer]\ninstructions = "Review."\ntools = ["read"]\nskills = ["$ROOT/skills/bare"]\n',
                prepare,
            );

            await assert.rejects(migration.run(), (error: Error) => {
                assert.match(error.message, /reviewer/);
                assert.ok(error.message.includes(`${migration.env.root}/skills/bare`), error.message);
                return true;
            });

            assert.equal(await readFile(migration.configFile, "utf8"), migration.original);
        });
    }
});

describe("converting an older role's instructions at startup", () => {
    it("writes a team role's instructions to its file, removes the key and seats the role (AC-1)", async () => {
        const started = await startWith('[roles.reviewer]\ninstructions = "Review the work."\ntools = ["read"]\n');

        const file = await readFile(roleInstructionPath(started.env.dataDir, "reviewer"), "utf8");
        assert.equal(file, "Review the work.");
        assert.equal(/instructions/.test(await started.read()), false);
        assert.equal(started.agents.runtime().catalog.seatFor("reviewer").role, "reviewer");
    });

    it("writes a shipped role's instructions to its file and marks the file edited (AC-2)", async () => {
        const started = await startWith('[roles.gp]\ninstructions = "Do the part."\n');

        assert.equal(await readFile(roleInstructionPath(started.env.dataDir, "gp"), "utf8"), "Do the part.");
        const states = await shippedFileStates({ dataDir: started.env.dataDir, shippedRoot: DEFAULT_SHIPPED_ROOT });
        assert.equal(states["instructions/roles/gp.md"]?.edited, true);
    });

    it("leaves config.toml byte for byte unchanged when no older key is present (AC-3)", async () => {
        const text = '# my settings\n[roles.reviewer]\n  tools = [ "read" ]\n\n\n[skills]\npaths = []\n';
        const started = await startWith(text);

        assert.equal(await started.read(), text);
    });

    it("keeps a section the migration does not own, as the file holds it (AC-1)", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const configFile = join(env.configDir, "config.toml");
        await writeFile(
            configFile,
            '[roles.reviewer]\ninstructions = "Review."\ntools = ["read"]\n\n[network]\naddress = "127.0.0.1"\nport = 4100\n',
        );
        const everything = [rolesSection, networkSection];
        const config = await loadConfig(configFile, everything);
        const store = createFileStore();
        await prepareInternalFolder({ dataDir: env.dataDir, shippedRoot: DEFAULT_SHIPPED_ROOT, store });

        const converted = await migrateOlderKeys({
            dirs: { configFile, dataDir: env.dataDir } as never,
            config,
            sections: [rolesSection],
            store,
        });

        assert.deepEqual(converted?.values.get("network"), { address: "127.0.0.1", port: 4100 });
        assert.match(await readFile(configFile, "utf8"), /\[network\]\naddress = "127.0.0.1"\nport = 4100/);
        assert.deepEqual(await loadConfig(configFile, everything), converted);
    });

    it("fails without rewriting the file when it changed after step 1 read it (AC-4)", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const configFile = join(env.configDir, "config.toml");
        const original = '[roles.reviewer]\ninstructions = "Review."\ntools = ["read"]\n';
        await writeFile(configFile, original);
        const sections = [rolesSection];
        const config = await loadConfig(configFile, sections);
        const store = createFileStore();
        await prepareInternalFolder({ dataDir: env.dataDir, shippedRoot: DEFAULT_SHIPPED_ROOT, store });
        const changed = `${original}# edited meanwhile\n`;
        await writeFile(configFile, changed);

        await assert.rejects(
            migrateOlderKeys({
                dirs: { configFile, dataDir: env.dataDir } as never,
                config,
                sections,
                store,
            }),
            /changed/,
        );

        assert.equal(await readFile(configFile, "utf8"), changed);
    });
});
