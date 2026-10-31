import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");
const WAIT_TIMEOUT_MS = 20_000;
const OWNER_ONLY_MODE = 0o700;
const quietLogger = createLogger({ stream: { write: () => true } });

const envs: HermeticEnv[] = [];
const children: ChildProcess[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermetic(configToml?: (env: HermeticEnv) => string): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    if (configToml) await writeFile(join(env.configDir, "config.toml"), configToml(env));
    return env;
}

function flagsOf(env: HermeticEnv) {
    return {
        configDir: env.configDir,
        stateDir: env.stateDir,
        dataDir: env.dataDir,
        runtimeDir: env.runtimeDir,
    };
}

type Serving = { stderr(): string; exit: Promise<number | null>; untilStderr(text: string): Promise<void> };

function serve(env: HermeticEnv): Serving {
    const flags = flagsOf(env);
    const args = [
        BOB_ENTRY,
        "serve",
        "--config-dir",
        flags.configDir,
        "--state-dir",
        flags.stateDir,
        "--data-dir",
        flags.dataDir,
        "--runtime-dir",
        flags.runtimeDir,
    ];
    const child = spawn(process.execPath, args, { env: env.env, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    return {
        stderr: () => stderr,
        exit: new Promise((resolve) => child.on("close", (code) => resolve(code))),
        async untilStderr(text) {
            const deadline = Date.now() + WAIT_TIMEOUT_MS;
            while (!stderr.includes(text)) {
                if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}" in: ${stderr}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
    };
}

async function startReady(env: HermeticEnv) {
    const agents = await createAgentsComponent({ logger: quietLogger });
    const daemon = runDaemon({
        flags: flagsOf(env),
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component],
        operations: agents.operations,
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return agents;
}

describe("the agents component at startup", () => {
    it("becomes ready with the roles bob and gp when there is no configuration file", async () => {
        const env = await hermetic();

        const agents = await startReady(env);

        assert.deepEqual(
            agents
                .runtime()
                .catalog.list()
                .map((role) => role.name),
            ["bob", "gp"],
        );
    });

    it("creates the default workspaces of bob and gp with mode 0700", async () => {
        const env = await hermetic();
        await startReady(env);

        for (const role of ["bob", "gp"]) {
            const info = await stat(join(env.dataDir, "workspaces", role));
            assert.equal(info.mode & 0o777, OWNER_ONLY_MODE, role);
        }
    });

    it("throws from runtime() before startup step 5", async () => {
        const agents = await createAgentsComponent({ logger: quietLogger });

        assert.throws(() => agents.runtime(), /step 5|not.*started|before/i);
    });

    it("installs the intern.role-prompt and intern.tools extensions", async () => {
        const agents = await createAgentsComponent({ logger: quietLogger });

        assert.deepEqual(
            (agents.component.extensions ?? []).map((extension) => extension.name),
            ["intern.role-prompt", "intern.tools"],
        );
    });

    it("stops at step 5 naming the role and the model when a role names a model that does not resolve", async () => {
        const env = await hermetic(() => '[roles.bob]\nmodel = "nowhere/missing-model"\n');
        const serving = serve(env);

        const status = await serving.exit;

        assert.notEqual(status, 0);
        assert.match(serving.stderr(), /startup failed step=5/);
        assert.match(serving.stderr(), /bob/);
        assert.match(serving.stderr(), /nowhere\/missing-model/);
    });

    it("stops at step 5 naming the role and the thinking level when the model does not support the level", async () => {
        const env = await hermetic(
            () => '[roles.gp]\nmodel = "amazon-bedrock/amazon.nova-lite-v1:0"\nthinking_level = "unsupported-level"\n',
        );
        const serving = serve(env);

        const status = await serving.exit;

        assert.notEqual(status, 0);
        assert.match(serving.stderr(), /startup failed step=5/);
        assert.match(serving.stderr(), /gp/);
        assert.match(serving.stderr(), /unsupported-level/);
    });

    it("stops at step 6 naming the path and the reason when a registered workspace fails the check", async () => {
        const env = await hermetic((e) => `[workspaces]\nregistered = ["${join(e.root, "missing-workspace")}"]\n`);
        const serving = serve(env);

        const status = await serving.exit;

        assert.notEqual(status, 0);
        assert.match(serving.stderr(), /startup failed step=6/);
        assert.match(serving.stderr(), /missing-workspace/);
        assert.match(serving.stderr(), /does not exist/);
    });

    it("stops at step 6 naming the path and the role when a role names an unregistered workspace", async () => {
        const env = await hermetic((e) => `[roles.gp]\nworkspace = "${join(e.root, "elsewhere")}"\n`);
        const serving = serve(env);

        const status = await serving.exit;

        assert.notEqual(status, 0);
        assert.match(serving.stderr(), /startup failed step=6/);
        assert.match(serving.stderr(), /elsewhere/);
        assert.match(serving.stderr(), /gp/);
        assert.match(serving.stderr(), /not registered/);
    });

    it("becomes ready under bob serve with no configuration file", async () => {
        const env = await hermetic();
        const serving = serve(env);

        await serving.untilStderr(" ready ");

        const info = await stat(join(env.dataDir, "workspaces", "bob"));
        assert.equal(info.mode & 0o777, OWNER_ONLY_MODE);
    });
});
