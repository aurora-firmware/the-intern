import { spawn } from "node:child_process";
import { join } from "node:path";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");

export type BobOptions = { runtimeDir?: string; env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string };
export type BobResult = { status: number | null; stdout: string; stderr: string };

/** Runs `node src/cli/bob.ts` as a child, with `--runtime-dir` when given, and collects its status and output. */
export function runBob(args: readonly string[], options: BobOptions = {}): Promise<BobResult> {
    const runtimeArgs = options.runtimeDir === undefined ? [] : ["--runtime-dir", options.runtimeDir];
    const child = spawn(process.execPath, [BOB_ENTRY, ...args, ...runtimeArgs], {
        env: options.env ?? process.env,
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.stdin.end(options.stdin ?? "");
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}
