import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { guardProcess } from "../support/process_guard.ts";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");
const WAIT_TIMEOUT_MS = 20_000;
const USAGE_EXIT_STATUS = 2;

const envs: HermeticEnv[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const env of envs.splice(0)) await env.dispose();
});

type Running = {
    stdout: () => string;
    stderr: () => string;
    signal(name: NodeJS.Signals): void;
    exit: Promise<number | null>;
    untilStderr(text: string): Promise<void>;
};

function run(args: string[], hermeticEnv: HermeticEnv): Running {
    const child = spawn(process.execPath, [BOB_ENTRY, ...args], {
        env: hermeticEnv.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    guardProcess(child, hermeticEnv.root);
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    return {
        stdout: () => stdout,
        stderr: () => stderr,
        signal: (name) => child.kill(name),
        exit,
        async untilStderr(text) {
            const deadline = Date.now() + WAIT_TIMEOUT_MS;
            while (!stderr.includes(text)) {
                if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}" in: ${stderr}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
    };
}

function directoryFlags(env: HermeticEnv): string[] {
    return [
        "--config-dir",
        env.configDir,
        "--state-dir",
        env.stateDir,
        "--data-dir",
        env.dataDir,
        "--runtime-dir",
        env.runtimeDir,
    ];
}

const DEFAULT_MODEL_SETTINGS = JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" });

/** The pi agent default is what the front desk is seated with at startup, so every daemon needs one to be ready. */
async function hermetic(hasDefaultModel = true): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    if (hasDefaultModel) await writeFile(join(env.piAgentDir, "settings.json"), DEFAULT_MODEL_SETTINGS);
    return env;
}

describe("bob serve", () => {
    it("writes the ready line to standard error and nothing to standard output when started with the directory flags", async () => {
        const env = await hermetic();
        const serve = run(["serve", ...directoryFlags(env)], env);

        await serve.untilStderr(" ready ");

        assert.ok(serve.stderr().includes(`stateDir=${env.stateDir}`), serve.stderr());
        assert.equal(serve.stdout(), "");
        serve.signal("SIGTERM");
        await serve.exit;
    });

    for (const name of ["SIGTERM", "SIGINT"] as const) {
        it(`exits with status 0 when ${name} arrives after ready`, async () => {
            const env = await hermetic();
            const serve = run(["serve", ...directoryFlags(env)], env);
            await serve.untilStderr(" ready ");

            serve.signal(name);

            assert.equal(await serve.exit, 0, serve.stderr());
        });
    }

    it("exits non-zero and names the failed step on standard error when startup fails", async () => {
        const env = await hermetic();
        await writeFile(join(env.configDir, "config.toml"), "this is = = not toml");
        const serve = run(["serve", ...directoryFlags(env)], env);

        const status = await serve.exit;

        assert.notEqual(status, 0);
        assert.ok(serve.stderr().includes("startup failed step=1"), serve.stderr());
    });

    for (const [description, args, expectedUsage] of [
        ["the command is missing", [], "Usage: bob <command>"],
        ["the command is unknown", ["frobnicate"], "Usage: bob <command>"],
        ["a flag is unknown", ["serve", "--bogus"], "Usage: bob serve"],
    ] as const) {
        it(`prints the usage to standard error and exits with 2 when ${description}`, async () => {
            const env = await hermetic();
            const serve = run([...args], env);

            assert.equal(await serve.exit, USAGE_EXIT_STATUS);
            assert.ok(serve.stderr().includes(expectedUsage), serve.stderr());
            assert.equal(serve.stdout(), "");
        });
    }

    it("writes debug lines to standard error only when --verbose is given", async () => {
        const env = await hermetic();
        const quiet = run(["serve", ...directoryFlags(env)], env);
        await quiet.untilStderr(" ready ");
        quiet.signal("SIGTERM");
        await quiet.exit;
        const verbose = run(["serve", "--verbose", ...directoryFlags(env)], env);
        await verbose.untilStderr(" ready ");
        verbose.signal("SIGTERM");
        await verbose.exit;

        assert.ok(!quiet.stderr().includes(" DEBUG "), quiet.stderr());
        assert.ok(verbose.stderr().includes(" DEBUG "), verbose.stderr());
    });
});
