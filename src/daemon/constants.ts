/** Built-in daemon limits. No configuration file, flag or environment variable changes them. */

export const WORKER_THREAD_COUNT = 32;

export const INVOCATION_DEPTH_CAP = 10;

/** Upper bound on shutdown and on the handling of a storage failure. */
export const STOP_BOUND_MS = 10_000;

/** Longest a submission wait operation blocks: 5 minutes. */
export const MAX_SUBMISSION_WAIT_MS = 300_000;
