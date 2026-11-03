import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");
const DEFAULT_WAIT_FOR_MS = 20_000;
const POLL_MS = 10;

export type PtySession = {
    /** Everything `bob` wrote to its terminal so far, input echo included. */
    output(): string;
    /** Everything `bob` wrote to standard error, which goes to a file instead of the terminal. */
    stderr(): string;
    /** Resolves once the stream's text so far contains the text; rejects after the timeout. */
    waitFor(stream: "output" | "stderr", text: string, timeoutMs?: number): Promise<void>;
    /** Types the keys on the terminal, such as `\x03` for Ctrl-C and `\x04` for Ctrl-D. */
    write(keys: string): void;
    /** Ends the session if it still runs. */
    kill(): void;
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
 * is redirected to a file inside the command, which keeps it apart from the terminal's output.
 */
export function runInPty(args: readonly string[], options: { runtimeDir: string }): PtySession {
    const directory = mkdtempSync(join(tmpdir(), "bob-pty-"));
    const stderrPath = join(directory, "stderr");
    const words = [process.execPath, BOB_ENTRY, ...args, "--runtime-dir", options.runtimeDir].map(shellQuote);
    const command = `${words.join(" ")} 2>${shellQuote(stderrPath)}`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk;
    });
    let finalStderr: string | undefined;
    const readStderr = () => {
        if (finalStderr !== undefined) return finalStderr;
        try {
            return readFileSync(stderrPath, "utf8");
        } catch {
            return "";
        }
    };
    const streams = { output: () => output, stderr: readStderr };
    const exited = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) => {
            finalStderr = readStderr();
            rmSync(directory, { recursive: true, force: true });
            resolve(status);
        });
    });
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
