/** The time a throttle reads and the timer it sets; a test gives it a clock it moves by hand. */
export type Clock = { now(): number; setTimer(run: () => void, ms: number): unknown };

const systemClock: Clock = { now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms) };

/**
 * Returns a trigger that runs `action` at most once per `intervalMs`. A call after a quiet interval runs at once; calls
 * within an interval run it once more when the interval is over, so the last change is never left unread.
 */
export const throttled = (action: () => void, intervalMs: number, clock: Clock = systemClock): (() => void) => {
    let lastRun = Number.NEGATIVE_INFINITY;
    let isWaiting = false;
    const run = () => {
        lastRun = clock.now();
        action();
    };
    return () => {
        if (isWaiting) return;
        const wait = lastRun + intervalMs - clock.now();
        if (wait <= 0) {
            run();
            return;
        }
        isWaiting = true;
        clock.setTimer(() => {
            isWaiting = false;
            run();
        }, wait);
    };
};
