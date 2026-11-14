/** How long a job may take to reach a status before a test treats it as stuck. */
export const JOB_STATUS_DEADLINE_MS = 30_000;

const POLL_INTERVAL_MS = 20;

/**
 * Polls a job's status until it equals `status`, and rejects at the deadline naming the status last seen. A new job
 * starts on the admission grant, after its prompt parts are read, so a test that acts on a new job waits for
 * `in_progress` first.
 */
export async function waitForJobStatus(
    statusOf: () => Promise<string | undefined>,
    status: string,
    deadlineMs: number = JOB_STATUS_DEADLINE_MS,
): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    let seen: string | undefined;
    while (Date.now() < deadline) {
        seen = await statusOf();
        if (seen === status) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`the job did not reach ${status} within ${deadlineMs} ms; last status ${seen}`);
}
