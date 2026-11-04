import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXIT_DEADLINE_MS, exitWithin } from "./exit_deadline.ts";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");
const DEFAULT_WAIT_FOR_MS = 20_000;
const POLL_MS = 10;

export type PtySession = {
    /** Everything `bob` wrote to its terminal so far, input echo included. */
    output(): string;
    /** Everything `bob` wrote to standard error, which goes to a file instead of the terminal. */
    stderr(): string;
    /** Everything `bob` wrote to standard output when the session redirects it to a file; empty otherwise. */
    stdout(): string;
    /** Resolves once the stream's text so far contains the text; rejects after the timeout. */
    waitFor(stream: "output" | "stderr" | "stdout", text: string, timeoutMs?: number): Promise<void>;
    /** Types the keys on the terminal, such as `\x03` for Ctrl-C and `\x04` for Ctrl-D. */
    write(keys: string): void;
    /** Ends the session if it still runs. */
    kill(): void;
    /** Resolves with the exit status; rejects, after killing the session, when it runs past the deadline. */
    exited: Promise<number | null>;
};

/** True where util-linux `script`, which gives Node a pseudo-terminal, is installed. */
export function hasScript(): boolean {
    return spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
}

function shellQuote(word: string): string {
    return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs `node src/cli/bob.ts <args>` under `script -qfec`, so standard input and output are a terminal. Standard error
 * is redirected to a file inside the command, which keeps it apart from the terminal's output. With
 * `redirectStdout`, standard output goes to a file too, so only standard input stays a terminal.
 */
export function runInPty(
    args: readonly string[],
    options: { runtimeDir: string; redirectStdout?: boolean; deadlineMs?: number },
): PtySession {
    const directory = mkdtempSync(join(tmpdir(), "bob-pty-"));
    const stderrPath = join(directory, "stderr");
    const stdoutPath = join(directory, "stdout");
    const words = [process.execPath, BOB_ENTRY, ...args, "--runtime-dir", options.runtimeDir].map(shellQuote);
    const redirection = options.redirectStdout ? ` >${shellQuote(stdoutPath)}` : "";
    const command = `${words.join(" ")}${redirection} 2>${shellQuote(stderrPath)}`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk;
    });
    const finalFiles = new Map<string, string>();
    const readFile = (path: string) => () => {
        const final = finalFiles.get(path);
        if (final !== undefined) return final;
        try {
            return readFileSync(path, "utf8");
        } catch {
            return "";
        }
    };
    const readStderr = readFile(stderrPath);
    const readStdout = readFile(stdoutPath);
    const streams = { output: () => output, stderr: readStderr, stdout: readStdout };
    child.once("close", () => {
        finalFiles.set(stderrPath, readStderr());
        finalFiles.set(stdoutPath, readStdout());
        rmSync(directory, { recursive: true, force: true });
    });
    const exited = exitWithin(child, `bob ${args.join(" ")}`, options.deadlineMs ?? DEFAULT_EXIT_DEADLINE_MS, () => {
        return `output ${JSON.stringify(output)}, stderr ${JSON.stringify(readStderr())}`;
    });
    // A test that never awaits `exited` must not turn the deadline into an unhandled rejection.
    exited.catch(() => {});
    return {
        ...streams,
        async waitFor(stream, text, timeoutMs = DEFAULT_WAIT_FOR_MS) {
            const deadline = Date.now() + timeoutMs;
            while (!streams[stream]().includes(text)) {
                if (Date.now() > deadline) {
                    throw new Error(
                        `timed out waiting for ${JSON.stringify(text)} on ${stream}; got ${streams[stream]()}`,
                    );
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
        },
        write: (keys) => {
            child.stdin.write(keys);
        },
        kill: () => {
            child.kill("SIGKILL");
        },
        exited,
    };
}
