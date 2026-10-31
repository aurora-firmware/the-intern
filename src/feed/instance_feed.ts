/**
 * The instance scope of the observation feed (S-002 R-14, R-11, R-22): every conversation with its status, the worker
 * threads in use, and then conversations being created, runs starting and finishing, admission changes and settings
 * changes. Publishing never waits for a subscriber; one that falls too far behind is closed with reason `lagging`.
 */

import type { Admission, AdmissionSnapshot } from "../admission/admission.ts";
import type { ConfigStore } from "../config/config_writer.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { watchInstance } from "../host/host_observation.ts";
import { type ConversationStatus, conversationStatus } from "../service/conversation_read_operations.ts";
import { createSubscription, FEED_MAX_PENDING, type Subscription } from "./observation_feed.ts";

export type InstanceSnapshot = {
    conversations: { id: string; status: ConversationStatus }[];
    admission: AdmissionSnapshot;
    workerThreads: { count: number; inUse: number };
};

export type InstanceDelta = { seq: number } & (
    | { type: "conversation_created" | "run_started" | "run_finished"; conversationId: string }
    | { type: "admission_changed"; admission: AdmissionSnapshot }
    | { type: "settings_changed"; section: string }
);

export type InstanceFeed = {
    subscribe(): Subscription<InstanceSnapshot, InstanceDelta>;
    close(): void;
};

type DeltaBody = InstanceDelta extends infer D ? (D extends unknown ? Omit<D, "seq"> : never) : never;
type Sink = { push(delta: InstanceDelta): void; end(reason: "stopped" | "unsubscribed"): void };

export async function createInstanceFeed(options: {
    host: HarnessHost;
    admission: Admission;
    config: ConfigStore;
    maxPending?: number;
}): Promise<InstanceFeed> {
    const { host, admission, config, maxPending = FEED_MAX_PENDING } = options;
    const sinks = new Set<Sink & { nextSeq(): number }>();
    const busyById = new Map<string, boolean>();

    function publish(body: DeltaBody): void {
        for (const sink of [...sinks]) sink.push({ ...body, seq: sink.nextSeq() } as InstanceDelta);
    }

    // The watch can report events before it returns; they are applied once the map holds its snapshot.
    const early: DeltaBody[] = [];
    let isReady = false;
    function onEvent(event: { type: "conversation_created" | "run_started" | "run_finished"; conversationId: string }) {
        if (!isReady) {
            early.push(event);
            return;
        }
        applyEvent(event);
    }
    function applyEvent(event: { type: string; conversationId: string }): void {
        busyById.set(event.conversationId, event.type === "run_started");
        publish(event as DeltaBody);
    }

    const watch = await watchInstance(host, onEvent);
    for (const { id, busy } of watch.snapshot.conversations) busyById.set(id, busy);
    isReady = true;
    for (const event of early.splice(0)) applyEvent(event as { type: string; conversationId: string });

    const stopAdmission = admission.onChange((snapshot) => publish({ type: "admission_changed", admission: snapshot }));
    const stopConfig = config.onChange(({ section }) => publish({ type: "settings_changed", section }));
    let isClosed = false;

    function snapshot(): InstanceSnapshot {
        const state = admission.state();
        return {
            conversations: [...busyById].map(([id, busy]) => ({ id, status: conversationStatus({ id, busy }, state) })),
            admission: state,
            workerThreads: { count: state.capacity, inUse: state.active.length },
        };
    }

    return {
        subscribe() {
            if (isClosed) throw new Error("The instance feed is closed; it accepts no new subscriptions.");
            let seq = 0;
            const { subscription, push, end } = createSubscription<InstanceSnapshot, InstanceDelta>(
                snapshot(),
                maxPending,
            );
            const sink = { push, end, nextSeq: () => ++seq };
            sinks.add(sink);
            return {
                ...subscription,
                close() {
                    sinks.delete(sink);
                    subscription.close();
                },
                async next() {
                    const result = await subscription.next();
                    if ("closed" in result) sinks.delete(sink);
                    return result;
                },
            };
        },
        close() {
            isClosed = true;
            watch.stop();
            stopAdmission();
            stopConfig();
            for (const sink of [...sinks]) sink.end("stopped");
            sinks.clear();
        },
    };
}
