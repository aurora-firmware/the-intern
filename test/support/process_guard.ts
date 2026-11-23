import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";

const GUARD_ENTRY = join(import.meta.dirname, "process_guard_child.ts");

/**
 * Makes `child`, a daemon started under the hermetic `root`, die with the test process. A test's own cleanup does not
 * run when the test process is killed, or times out and is cancelled, so a guard process holds an IPC channel to the
 * test process: when the channel closes, the guard kills the daemon and removes `root`. After `child` exits normally
 * the guard is released without removing `root`, which the test's own cleanup owns.
 */
export function guardProcess(child: ChildProcess, root: string): void {
    if (child.pid === undefined) return;
    const guard = fork(GUARD_ENTRY, [String(child.pid), root], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    // The guard must not keep the test process alive.
    guard.unref();
    guard.channel?.unref();
    child.once("exit", () => {
        if (guard.connected) guard.send({ released: true }, () => guard.disconnect());
    });
}
