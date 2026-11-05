/**
 * The guard of `process_guard.ts`: `node process_guard_child.ts <pid> <root>`, forked by a test process with an IPC
 * channel. When the channel closes, it stops the guarded process if it still runs, and unless the test process sent
 * `{ released: true }` first (the test ended normally), it also removes the hermetic root. SIGKILL of the test process
 * closes the channel, which is why this runs in a process of its own.
 */
import { readFileSync, rmSync } from "node:fs";

const [pidArgument, root] = process.argv.slice(2);
const pid = Number(pidArgument);
let isReleased = false;

/** The pid may have been reused after the process ended, so it counts only while its arguments name the root. */
function isGuardedProcess(): boolean {
    try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(root ?? "\0");
    } catch {
        return false;
    }
}

process.on("message", (message) => {
    if (typeof message === "object" && message !== null && (message as { released?: unknown }).released === true) {
        isReleased = true;
    }
});

process.on("disconnect", () => {
    if (isGuardedProcess()) process.kill(pid, "SIGKILL");
    if (!isReleased && root !== undefined) rmSync(root, { recursive: true, force: true });
    process.exit(0);
});
