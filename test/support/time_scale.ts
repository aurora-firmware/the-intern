import { availableParallelism, loadavg } from "node:os";

/**
 * The smallest factor without `TEST_TIME_SCALE`. The load is read once per test file, and another project on the same
 * machine can double it within a minute, so the waits start at twice their written length.
 */
const MIN_LOAD_SCALE = 2;
/** The largest factor the load alone may set; `TEST_TIME_SCALE` may go higher. */
const MAX_LOAD_SCALE = 4;
/**
 * The largest `TEST_TIME_SCALE`: some tests send a scaled wait of up to 30 s to `submissions.wait`, which takes at
 * most 300 s (`MAX_SUBMISSION_WAIT_MS`).
 */
const MAX_SCALE = 10;

/**
 * How much longer than written the tests' waits and timeouts are. `TEST_TIME_SCALE` sets it (a number from 1 to 10).
 * Without it, the load sets it: twice the one-minute load average per core, between 2 and 4, read once when the test
 * file loads. `TEST_TIME_SCALE=1` keeps the written waits, so a hang shows sooner.
 */
export const TIME_SCALE = readScale();

/**
 * `ms` stretched by `TIME_SCALE`, for a wait or timeout that a slow machine must not fail. Never for a value sent to
 * the product, such as a `timeoutMs` above 30 s or a time the product must keep to.
 */
export function scaled(ms: number): number {
    return Math.round(ms * TIME_SCALE);
}

function readScale(): number {
    const configured = process.env.TEST_TIME_SCALE;
    if (configured !== undefined && configured !== "") {
        const value = Number(configured);
        if (!Number.isFinite(value) || value < 1 || value > MAX_SCALE) {
            throw new Error(`TEST_TIME_SCALE must be a number from 1 to ${MAX_SCALE}, not "${configured}"`);
        }
        return value;
    }
    const perCore = (loadavg()[0] ?? 0) / availableParallelism();
    return Math.min(MAX_LOAD_SCALE, Math.max(MIN_LOAD_SCALE, perCore * 2));
}
