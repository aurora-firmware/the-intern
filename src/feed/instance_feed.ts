/**
 * The instance scope of the observation feed (S-002 REQ-014, REQ-011, REQ-022): every conversation with its status, the
 * worker threads in use, and then conversations being created, runs starting and finishing, admission changes and
 * settings changes. Publishing never waits for a subscriber; one that falls too far behind is closed with reason
 * `lagging`.
 */

import type { Admission, AdmissionSnapshot } from "../admission/admission.ts";
import type { ConfigStore } from "../config/config_writer.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { type InstanceEvent, watchConversationMeta, watchInstance } from "../host/host_observation.ts";
import type { ConversationMeta, SeatSummary } from "../host/seating.ts";
import { readConversationMeta } from "../host/seating.ts";
import { type ConversationListing, conversationStatus } from "../service/conversation_read_operations.ts";
import { createSubscription, FEED_MAX_PENDING, type Subscription } from "./observation_feed.ts";

export type InstanceSnapshot = {
    conversations: Pick<ConversationListing, "id" | "jobId" | "isLead" | "seat" | "status">[];
    admission: AdmissionSnapshot;
    workerThreads: { count: number; inUse: number };
};

export type InstanceDelta = { seq: number } & (
    | { type: "conversation_created" | "run_started" | "run_finished"; conversationId: string }
    | { type: "seat_changed"; conversationId: string; seat: SeatSummary }
    | { type: "status_changed"; conversationId: string; status: ConversationListing["status"] }
    | { type: "admission_changed"; admission: AdmissionSnapshot }
    | { type: "settings_changed"; section: string }
);

export type InstanceFeed = {
    subscribe(): Subscription<InstanceSnapshot, InstanceDelta>;
    close(): void;
};

type DeltaBody = InstanceDelta extends infer D ? (D extends unknown ? Omit<D, "seq"> : never) : never;
type ConversationFacts = { jobId: string; isLead: boolean; seat: SeatSummary; isParked: boolean };
type Sink = { push(delta: InstanceDelta): void; end(reason: "stopped" | "unsubscribed"): void };

function factsOf(meta: ConversationMeta): ConversationFacts {
    const { role, model, thinkingLevel, workspace } = meta.seat;
    return {
        jobId: meta.jobId,
        isLead: meta.isLead,
        seat: { role, model, ...(thinkingLevel !== undefined && { thinkingLevel }), workspace },
        isParked: meta.parked !== null,
    };
}

export async function createInstanceFeed(options: {
    host: HarnessHost;
    admission: Admission;
    config: ConfigStore;
    maxPending?: number;
}): Promise<InstanceFeed> {
    const { host, admission, config, maxPending = FEED_MAX_PENDING } = options;
    const sinks = new Set<Sink & { nextSeq(): number }>();
    const busyById = new Map<string, boolean>();
    const factsById = new Map<string, ConversationFacts>();

    function publish(body: DeltaBody): void {
        for (const sink of [...sinks]) sink.push({ ...body, seq: sink.nextSeq() } as InstanceDelta);
    }

    // The watch can report events before it returns; they are applied once the map holds its snapshot.
    const early: InstanceEvent[] = [];
    let isReady = false;
    function onEvent(event: InstanceEvent): void {
        if (!isReady) {
            early.push(event);
            return;
        }
        applyEvent(event);
    }
    function applyEvent(event: InstanceEvent): void {
        busyById.set(event.conversationId, event.type === "run_started");
        publish(event);
    }

    function statusOf(id: string, isParked: boolean): ConversationListing["status"] {
        return conversationStatus({ id, busy: busyById.get(id) ?? false, isParked }, admission.state());
    }

    // A change of the conversation's document publishes the seat or the status only when that part of it changed; a
    // conversation heard of for the first time has nothing to compare with and is announced by its creation.
    function applyMeta(conversationId: string, meta: ConversationMeta): void {
        const before = factsById.get(conversationId);
        const after = factsOf(meta);
        factsById.set(conversationId, after);
        if (!before || !isReady) return;
        if (JSON.stringify(before.seat) !== JSON.stringify(after.seat)) {
            publish({ type: "seat_changed", conversationId, seat: after.seat });
        }
        if (before.isParked !== after.isParked) {
            publish({ type: "status_changed", conversationId, status: statusOf(conversationId, after.isParked) });
        }
    }

    const earlyMeta: { conversationId: string; meta: ConversationMeta }[] = [];
    const metaWatch = await watchConversationMeta(host, (change) => {
        if (isReady) applyMeta(change.conversationId, change.meta);
        else earlyMeta.push(change);
    });
    let watch: Awaited<ReturnType<typeof watchInstance>>;
    try {
        watch = await watchInstance(host, onEvent);
        for (const { id, busy } of watch.snapshot.conversations) {
            busyById.set(id, busy);
            const meta = await readConversationMeta(host, id);
            if (meta !== undefined) factsById.set(id, factsOf(meta));
        }
    } catch (error) {
        metaWatch.stop();
        throw error;
    }
    isReady = true;
    for (const event of early.splice(0)) applyEvent(event);
    for (const { conversationId, meta } of earlyMeta.splice(0)) applyMeta(conversationId, meta);

    const stopAdmission = admission.onChange((snapshot) => publish({ type: "admission_changed", admission: snapshot }));
    const stopConfig = config.onChange(({ section }) => publish({ type: "settings_changed", section }));
    let isClosed = false;

    function snapshot(): InstanceSnapshot {
        const state = admission.state();
        return {
            conversations: [...busyById.keys()].map((id) => {
                const facts = factsById.get(id);
                return {
                    id,
                    jobId: facts?.jobId ?? null,
                    isLead: facts?.isLead ?? false,
                    seat: facts?.seat ?? null,
                    status: conversationStatus(
                        { id, busy: busyById.get(id) ?? false, isParked: facts?.isParked },
                        state,
                    ),
                };
            }),
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
            // Mirrors the subscription's own buffer so a subscriber it closes as lagging is dropped from the feed
            // at once, not when (if ever) it reads again.
            let undelivered = 0;
            let isReaderWaiting = false;
            const sink = {
                push(delta: InstanceDelta) {
                    push(delta);
                    if (isReaderWaiting) {
                        isReaderWaiting = false;
                        return;
                    }
                    undelivered++;
                    if (undelivered > maxPending) sinks.delete(sink);
                },
                end,
                nextSeq: () => ++seq,
            };
            sinks.add(sink);
            return {
                ...subscription,
                close() {
                    sinks.delete(sink);
                    subscription.close();
                },
                async next() {
                    if (undelivered > 0) undelivered--;
                    else isReaderWaiting = true;
                    const result = await subscription.next();
                    if ("closed" in result) sinks.delete(sink);
                    return result;
                },
            };
        },
        close() {
            isClosed = true;
            watch.stop();
            metaWatch.stop();
            stopAdmission();
            stopConfig();
            for (const sink of [...sinks]) sink.end("stopped");
            sinks.clear();
        },
    };
}
