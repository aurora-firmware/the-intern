import { execFileSync } from "node:child_process";

/**
 * The full command line of process `pid`, or undefined once no such process exists. It asks `ps`, which Linux and macOS
 * both ship, because macOS has no `/proc`. A lookup that cannot run throws: "cannot check" must never read as "gone".
 */
export function processCommand(pid: number, psPath = "ps"): string | undefined {
    let output: string;
    try {
        output = execFileSync(psPath, ["-ww", "-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (error) {
        // ps exits 1 with no output when the pid does not exist.
        if ((error as { status?: unknown }).status === 1 && String((error as { stdout?: unknown }).stdout) === "") {
            return undefined;
        }
        throw new Error(`cannot look up process ${pid} with ${psPath}: ${(error as Error).message}`, { cause: error });
    }
    return output.trim() === "" ? undefined : output.trim();
}
