/**
 * A stand-in for a test process that starts a daemon: `node orphan_fixture.ts serve|forked`. It starts the daemon the
 * way the test files do, then prints `{ "pid": <daemon pid>, "root": <hermetic root> }` once the daemon is ready, and
 * waits to be killed.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";
import { guardProcess } from "./process_guard.ts";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");
const READY_TEXT = " ready ";
const HOLD_MS = 600_000;
const DEFAULT_MODEL_SETTINGS = JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" });

function report(pid: number, env: HermeticEnv): void {
    process.stdout.write(`${JSON.stringify({ pid, root: env.root })}\n`);
}

async function startServe(env: HermeticEnv): Promise<void> {
    const args = [
        BOB_ENTRY,
        "serve",
        "--config-dir",
        env.configDir,
        "--state-dir",
        env.stateDir,
        "--data-dir",
        env.dataDir,
        "--runtime-dir",
        env.runtimeDir,
    ];
    const child = spawn(process.execPath, args, { env: env.env, stdio: ["ignore", "ignore", "pipe"] });
    guardProcess(child, env.root);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes(READY_TEXT)) report(child.pid ?? 0, env);
    });
}

async function startForkedDaemon(env: HermeticEnv): Promise<void> {
    const { startDaemon } = await import("./daemon_process.ts");
    const daemon = startDaemon({ hermetic: env });
    await daemon.ready;
    report(daemon.pid, env);
}

const env = await createHermeticEnv();
// The front desk needs a pi agent default model to be seated, so the daemon can become ready.
await writeFile(join(env.piAgentDir, "settings.json"), DEFAULT_MODEL_SETTINGS);
if (process.argv[2] === "serve") await startServe(env);
else await startForkedDaemon(env);
setTimeout(() => undefined, HOLD_MS);
