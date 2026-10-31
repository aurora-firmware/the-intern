/**
 * Admission (S-002 component 6, R-10, R-11): which conversations may make model requests, held in the session-wide
 * document `intern.admission` so the order survives a restart. Every change is its own commit, because the document
 * is the fact itself. `restore()` must run at startup before `host.resume()`.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Extension } from "@earendil-works/pi-durable";
import type { Logger } from "../daemon/logger.ts";
import { type HarnessHost, internalHarness } from "../host/harness_host.ts";
import { liveTasks } from "../host/host_inspection.ts";
import { watchInstance } from "../host/host_observation.ts";
import { type AdmissionGate, createAdmissionGate } from "./admission_extension.ts";
import { type AdmissionState, positions, release, request, restore } from "./admission_queue.ts";

const context = BACKGROUND_CONTEXT;

export type AdmissionSnapshot = {
    capacity: number;
    active: string[];
    waiting: { conversationId: string; position: number }[];
};

export type Admission = {
    extension: Extension;
    restore(): Promise<void>;
    acquire(conversationId: string, signal: AbortSignal): Promise<void>;
    release(conversationId: string): Promise<void>;
    state(): AdmissionSnapshot;
    onChange(listener: (snapshot: AdmissionSnapshot) => void): () => void;
    stop(): void;
};

export type AdmissionOptions = {
    host: HarnessHost;
    capacity: number;
    logger: Logger;
    /** The gate whose extension the host was opened with. Without one, the admission makes its own extension. */
    gate?: AdmissionGate;
};

const admissionDocument = defineDoc<AdmissionState>({
    kind: "intern.admission",
    version: 1,
    scope: "session",
    initial: () => ({ active: [], waiting: [] }),
    checkpointWhen: () => false,
});

type Waiter = { promise: Promise<void>; grant(): void };

function createWaiter(): Waiter {
    let grant = (): void => {};
    const promise = new Promise<void>((resolve) => {
        grant = resolve;
    });
    return { promise, grant };
}

function rejectWhenAborted(signal: AbortSignal): { aborted: Promise<never>; dispose(): void } {
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("The wait for a worker thread was aborted."));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    });
    return { aborted, dispose: () => signal.removeEventListener("abort", onAbort) };
}

export function createAdmission(options: AdmissionOptions): Admission {
    const { host, capacity, logger } = options;
    const harness = internalHarness(host);
    const gate = options.gate ?? createAdmissionGate();
    const waiters = new Map<string, Waiter>();
    const listeners = new Set<(snapshot: AdmissionSnapshot) => void>();
    let current: AdmissionState = { active: [], waiting: [] };
    let pendingChange: Promise<unknown> = Promise.resolve();
    let stopWatching: (() => void) | undefined;

    const snapshot = (): AdmissionSnapshot => ({
        capacity,
        active: [...current.active],
        waiting: positions(current),
    });

    // Changes run one at a time, so each commit is computed from the state the previous one stored.
    function serialize<T>(change: () => Promise<T>): Promise<T> {
        const result = pendingChange.then(change);
        pendingChange = result.catch(() => undefined);
        return result;
    }

    async function store(next: AdmissionState, granted: string[]): Promise<void> {
        await harness.commit(async (tx) => {
            const draft = await tx.doc(admissionDocument);
            draft.active = [...next.active];
            draft.waiting = [...next.waiting];
        }, context);
        current = next;
        for (const id of granted) {
            waiters.get(id)?.grant();
            waiters.delete(id);
        }
        for (const listener of listeners) listener(snapshot());
    }

    async function readStored(): Promise<AdmissionState> {
        const stored = await harness.snapshot(admissionDocument, context);
        return { active: [...(stored?.active ?? [])], waiting: [...(stored?.waiting ?? [])] };
    }

    async function hasUnfinishedTask(conversationId: string): Promise<boolean> {
        try {
            return (await liveTasks(host, conversationId)).length > 0;
        } catch (error) {
            if ((error as Error).name === "HostNotFoundError") return false;
            throw error;
        }
    }

    // A run going idle and its release are two commits, so a crash between them leaves a stale entry behind.
    async function dropFinishedConversations(stored: AdmissionState): Promise<AdmissionState> {
        const isLive = new Map<string, boolean>();
        for (const id of [...stored.active, ...stored.waiting]) isLive.set(id, await hasUnfinishedTask(id));
        const dropped = [...isLive].filter(([, hasTask]) => !hasTask).map(([id]) => id);
        if (dropped.length > 0)
            logger.info("admission dropped conversations without an unfinished task", { dropped: dropped.join(",") });
        return {
            active: stored.active.filter((id) => isLive.get(id)),
            waiting: stored.waiting.filter((id) => isLive.get(id)),
        };
    }

    function releaseNow(conversationId: string): Promise<void> {
        return serialize(async () => {
            waiters.delete(conversationId);
            const result = release(current, conversationId, capacity);
            if (
                result.state.active.length === current.active.length &&
                result.state.waiting.length === current.waiting.length
            ) {
                return;
            }
            await store(result.state, result.granted);
        });
    }

    async function acquire(conversationId: string, signal: AbortSignal): Promise<void> {
        const { aborted, dispose } = rejectWhenAborted(signal);
        try {
            const waiter = await Promise.race([enqueue(conversationId), aborted]);
            if (waiter) await Promise.race([waiter.promise, aborted]);
        } finally {
            dispose();
        }
    }

    // Returns the waiter to await, or undefined when the conversation already holds a worker thread.
    function enqueue(conversationId: string): Promise<Waiter | undefined> {
        return serialize(async () => {
            const result = request(current, conversationId, capacity);
            if (result.granted) {
                if (result.state !== current) await store(result.state, []);
                return undefined;
            }
            const waiter = waiters.get(conversationId) ?? createWaiter();
            waiters.set(conversationId, waiter);
            if (result.state !== current) await store(result.state, []);
            return waiter;
        });
    }

    gate.bind(acquire);
    return {
        extension: gate.extension,
        async restore() {
            const stored = await dropFinishedConversations(await readStored());
            const result = restore(stored, capacity);
            await serialize(() => store(result.state, result.granted));
            const watch = await watchInstance(host, (event) => {
                if (event.type !== "run_finished") return;
                releaseNow(event.conversationId).catch((error: unknown) =>
                    logger.error("admission could not release a worker thread", {
                        conversationId: event.conversationId,
                        error: String(error),
                    }),
                );
            });
            stopWatching = () => watch.stop();
        },
        acquire,
        release: releaseNow,
        state: snapshot,
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        stop() {
            stopWatching?.();
            listeners.clear();
        },
    };
}
