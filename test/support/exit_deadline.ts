import type { ChildProcess } from "node:child_process";

/** How long a `bob` child may run before a test treats it as hung. A test that needs longer sets its own deadline. */
export const DEFAULT_EXIT_DEADLINE_MS = 120_000;

/**
 * Resolves with the child's exit status once it closes. A child still running at the deadline is killed with
 * `SIGKILL` and the promise rejects, so a `bob` that never exits fails its test instead of hanging the run.
 */
export function exitWithin(
    child: ChildProcess,
    label: string,
    deadlineMs: number = DEFAULT_EXIT_DEADLINE_MS,
    describeOutput: () => string = () => "",
): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${label} did not exit within ${deadlineMs} ms; ${describeOutput()}`));
        }, deadlineMs);
        // A child that exits in time must not leave the timer holding the test process open.
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (status) => {
            clearTimeout(timer);
            resolve(status);
        });
    });
}
