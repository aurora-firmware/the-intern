/**
 * The status of each account (S-009 REQ-005, ADR-010 decision 4): its status word, last error and its time, last check,
 * the retry timer of a failing account and the hub that publishes changes. It knows no mail library and no pi package.
 */

/** What an account's status reads time from. It has the shape of the schedules' clock, so a test passes its own. */
export type AccountClock = {
    now(): Date;
    /** Settles when the clock reaches `until`, or as soon as `signal` aborts. */
    wait(until: Date, signal: AbortSignal): Promise<void>;
};

export type AccountStatusKind = "connecting" | "ready" | "failing" | "needs_sign_in";

export type AccountStatusView = {
    owner: string;
    name: string;
    status: AccountStatusKind;
    lastError?: { message: string; at: Date };
    lastCheck?: Date;
};

export type CheckOutcome = { kind: "ready" } | { kind: "failing" | "needs_sign_in"; message: string };

export type AccountStartOptions = {
    checkIntervalSeconds: number;
    needsSignIn: boolean;
    /** Called when a failing account is due another check; the check reports its outcome with `report`. */
    retry: () => void;
};

export type AccountStatusHub = {
    start(owner: string, name: string, options: AccountStartOptions): void;
    report(owner: string, name: string, outcome: CheckOutcome): void;
    /** Sets the last error and its time and publishes once; the status, the last check and the retry timer stay. */
    noteError(owner: string, name: string, message: string): void;
    /** Cancels the account's timer and forgets it. */
    stop(owner: string, name: string): void;
    get(owner: string, name: string): AccountStatusView | undefined;
    list(owner: string): AccountStatusView[];
    /** Returns a function that removes the listener. */
    onChange(listener: (view: AccountStatusView) => void): () => void;
};

export const MAX_RETRY_PAUSE_SECONDS = 30 * 60;

const realClock: AccountClock = {
    now: () => new Date(),
    wait: (until, signal) =>
        new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
            };
            const timer = setTimeout(done, Math.max(0, until.getTime() - Date.now()));
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
        }),
};

type Entry = {
    view: AccountStatusView;
    options: AccountStartOptions;
    pauseSeconds: number;
    timer?: AbortController;
};

const keyOf = (owner: string, name: string): string => JSON.stringify([owner, name]);

const copyOf = (view: AccountStatusView): AccountStatusView => ({
    ...view,
    ...(view.lastError ? { lastError: { ...view.lastError } } : {}),
});

export function createAccountStatusHub(options: { clock?: AccountClock } = {}): AccountStatusHub {
    const clock = options.clock ?? realClock;
    const entries = new Map<string, Entry>();
    const listeners = new Set<(view: AccountStatusView) => void>();

    const publish = (entry: Entry): void => {
        for (const listener of [...listeners]) listener(copyOf(entry.view));
    };

    const cancelTimer = (entry: Entry): void => {
        entry.timer?.abort();
        entry.timer = undefined;
    };

    const scheduleRetry = (entry: Entry): void => {
        const controller = new AbortController();
        entry.timer = controller;
        const until = new Date(clock.now().getTime() + entry.pauseSeconds * 1000);
        entry.pauseSeconds = Math.min(entry.pauseSeconds * 2, MAX_RETRY_PAUSE_SECONDS);
        void clock.wait(until, controller.signal).then(() => {
            if (controller.signal.aborted) return;
            entry.timer = undefined;
            entry.options.retry();
        });
    };

    return {
        start(owner, name, startOptions) {
            const key = keyOf(owner, name);
            const previous = entries.get(key);
            if (previous) cancelTimer(previous);
            const entry: Entry = {
                view: { owner, name, status: startOptions.needsSignIn ? "needs_sign_in" : "connecting" },
                options: startOptions,
                pauseSeconds: Math.min(startOptions.checkIntervalSeconds, MAX_RETRY_PAUSE_SECONDS),
            };
            entries.set(key, entry);
            publish(entry);
        },
        report(owner, name, outcome) {
            const entry = entries.get(keyOf(owner, name));
            if (!entry) return;
            cancelTimer(entry);
            const at = clock.now();
            entry.view.lastCheck = at;
            if (outcome.kind === "ready") {
                entry.view.status = "ready";
                entry.pauseSeconds = Math.min(entry.options.checkIntervalSeconds, MAX_RETRY_PAUSE_SECONDS);
            } else {
                entry.view.status = outcome.kind;
                entry.view.lastError = { message: outcome.message, at };
                if (outcome.kind === "failing") scheduleRetry(entry);
            }
            publish(entry);
        },
        noteError(owner, name, message) {
            const entry = entries.get(keyOf(owner, name));
            if (!entry) return;
            entry.view.lastError = { message, at: clock.now() };
            publish(entry);
        },
        stop(owner, name) {
            const key = keyOf(owner, name);
            const entry = entries.get(key);
            if (!entry) return;
            cancelTimer(entry);
            entries.delete(key);
        },
        get(owner, name) {
            const entry = entries.get(keyOf(owner, name));
            return entry ? copyOf(entry.view) : undefined;
        },
        list(owner) {
            return [...entries.values()].filter((entry) => entry.view.owner === owner).map((e) => copyOf(e.view));
        },
        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
