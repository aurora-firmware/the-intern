/**
 * The lowest measurement over up to `attempts` runs, stopping at the first one within `limit`.
 *
 * A wall-clock limit is a statement about what the page can do. One sample on a loaded host also holds the delay of
 * scheduling, so a limit holds when any attempt meets it, and a real slowdown fails every attempt.
 */
export async function bestOf(attempts: number, measure: () => Promise<number>, limit: number): Promise<number> {
    if (attempts < 1) throw new Error(`bestOf needs at least one attempt, got ${attempts}`);
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < attempts && best > limit; attempt++) {
        best = Math.min(best, await measure());
    }
    return best;
}
