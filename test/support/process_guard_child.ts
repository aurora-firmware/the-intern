/**
 * The guard of `process_guard.ts`: `node process_guard_child.ts <pid> <root>`, forked by a test process with an IPC
 * channel. When the channel closes, it stops the guarded process if it still runs, and unless the test process sent
 * `{ released: true }` first (the test ended normally), it also removes the hermetic root. SIGKILL of the test process
 * closes the channel, which is why this runs in a process of its own.
 */
import { rmSync } from "node:fs";
import { processCommand } from "./process_command.ts";

const [pidArgument, root] = process.argv.slice(2);
const pid = Number(pidArgument);
let isReleased = false;

/** The pid may have been reused after the process ended, so it counts only while its arguments name the root. */
function isGuardedProcess(): boolean {
    return processCommand(pid)?.includes(root ?? "\0") ?? false;
}

process.on("message", (message) => {
    if (typeof message === "object" && message !== null && (message as { released?: unknown }).released === true) {
        isReleased = true;
    }
});

process.on("disconnect", () => {
    try {
        if (isGuardedProcess()) process.kill(pid, "SIGKILL");
    } catch (error) {
        // The daemon may still run, so the root stays: removing it would delete the folder under a live process.
        console.error(error);
        process.exit(1);
    }
    if (!isReleased && root !== undefined) rmSync(root, { recursive: true, force: true });
    process.exit(0);
});
