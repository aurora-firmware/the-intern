import { spawn } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_EXIT_DEADLINE_MS, exitWithin } from "./exit_deadline.ts";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");

export type BobOptions = {
    runtimeDir?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    cwd?: string;
    /** How long `bob` may run before the test fails and the child is killed. */
    deadlineMs?: number;
};
export type BobResult = { status: number | null; stdout: string; stderr: string };

/** Runs `node src/cli/bob.ts` as a child, with `--runtime-dir` when given, and collects its status and output. */
export async function runBob(args: readonly string[], options: BobOptions = {}): Promise<BobResult> {
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
    const status = await exitWithin(
        child,
        `bob ${args.join(" ")}`,
        options.deadlineMs ?? DEFAULT_EXIT_DEADLINE_MS,
        () => {
            return `stdout ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}`;
        },
    );
    return { status, stdout, stderr };
}

export type BobChild = {
    stdout(): string;
    stderr(): string;
    /** Resolves once the stream's text so far contains the given text; rejects after the timeout. */
    waitFor(stream: "stdout" | "stderr", text: string, timeoutMs?: number): Promise<void>;
    write(text: string): void;
    /** Ends standard input, as the end of a pipe does. */
    endInput(): void;
    signal(sig: NodeJS.Signals): void;
    /** Resolves with the exit status when the child exits; rejects, after killing it, when it runs past the deadline. */
    exited: Promise<number | null>;
};

const DEFAULT_WAIT_FOR_MS = 20_000;
const WAIT_FOR_POLL_MS = 10;

/** Starts `node src/cli/bob.ts` as a child that keeps running; the test reads its output as it arrives. */
export function spawnBob(
    args: readonly string[],
    options: { runtimeDir?: string; env?: NodeJS.ProcessEnv; cwd?: string; deadlineMs?: number } = {},
): BobChild {
    const runtimeArgs = options.runtimeDir === undefined ? [] : ["--runtime-dir", options.runtimeDir];
    const child = spawn(process.execPath, [BOB_ENTRY, ...args, ...runtimeArgs], {
        env: options.env ?? process.env,
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        stdio: ["pipe", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => {
        output.stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        output.stderr += chunk;
    });
    const exited = exitWithin(child, `bob ${args.join(" ")}`, options.deadlineMs ?? DEFAULT_EXIT_DEADLINE_MS, () => {
        return `stdout ${JSON.stringify(output.stdout)}, stderr ${JSON.stringify(output.stderr)}`;
    });
    // A test that never awaits `exited` must not turn the deadline into an unhandled rejection.
    exited.catch(() => {});
    return {
        stdout: () => output.stdout,
        stderr: () => output.stderr,
        async waitFor(stream, text, timeoutMs = DEFAULT_WAIT_FOR_MS) {
            const deadline = Date.now() + timeoutMs;
            while (!output[stream].includes(text)) {
                if (Date.now() > deadline) {
                    throw new Error(
                        `timed out waiting for ${JSON.stringify(text)} on ${stream}; got ${output[stream]}`,
                    );
                }
                await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_POLL_MS));
            }
        },
        write: (text) => {
            child.stdin.write(text);
        },
        endInput: () => {
            child.stdin.end();
        },
        signal: (sig) => {
            child.kill(sig);
        },
        exited,
    };
}
