/**
 * Committed-change observation (the input of the S-002 Observation feed): the observation feed and admission watch
 * conversations and the instance through these functions, never through pi-durable. Listeners run synchronously inside
 * pi-durable's delivery and are never awaited, so a listener can't delay a commit; buffering is the feed's job.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange, ConversationId, EntryRecord, JsonObject, TaskId } from "@earendil-works/pi-durable";
import { HostNotFoundError } from "./conversation_control.ts";
import { parseConversationId, toConversationId } from "./conversation_id.ts";
import { type HarnessHost, type HostEntry, internalHarness, toHostEntry } from "./harness_host.ts";
import {
    CONVERSATION_META_KIND,
    type ConversationMeta,
    SEAT_RECORD_KIND,
    type SeatRecord,
    type SeatSummary,
} from "./seating.ts";

const context = BACKGROUND_CONTEXT;

export type ConversationView = { live: unknown; inbox: unknown; busy: boolean };
/** Where a conversation stands: its newest entry's id, or null when it has none, and its state (ADR-008 decision 1). */
export type ConversationSnapshot = ConversationView & { newestEntryId: string | null };
/** An entry as `conversations.entries` shows it: an assistant entry names the seat that produced it. */
export type WatchedEntry = HostEntry & { seat?: SeatSummary };
/** What one commit changed: the state, and the entries it added, in order (ADR-008 decision 2). */
export type ConversationFrame = { view: ConversationView; entries: WatchedEntry[] };
export type InstanceEvent = {
    type: "conversation_created" | "run_started" | "run_finished";
    conversationId: string;
};

type LiveState = { run?: unknown; compactions?: unknown[] };
type StructuralView = { entries: readonly EntryRecord[]; docs: Readonly<Record<string, JsonObject>> };

// Busy is read from the view itself, so it always describes the same commit as the entries: a run is recorded in
// `pi.live` from its start to its end, and a compaction is listed there while it works.
function isViewBusy(docs: StructuralView["docs"]): boolean {
    const live = docs["pi.live"] as LiveState | undefined;
    return live?.run !== undefined || (live?.compactions?.length ?? 0) > 0;
}

function toConversationView(view: StructuralView): ConversationView {
    return {
        live: view.docs["pi.live"] ?? null,
        inbox: view.docs["pi.inbox"] ?? null,
        busy: isViewBusy(view.docs),
    };
}

const ASSISTANT_ENTRY_KIND = "pi.assistant";

function seatOfMeta(meta: ConversationMeta | undefined): SeatSummary | undefined {
    if (meta === undefined || meta.seat.model === "") return undefined;
    const { role, model, thinkingLevel, workspace } = meta.seat;
    return { role, model, ...(thinkingLevel !== undefined && { thinkingLevel }), workspace };
}

// The seat at attachment: the latest seat record in the view, otherwise the conversation's document. A view without a
// seat record holds no seat change, so the document's seat is the one that produced its entries.
function seatAtAttachment(view: StructuralView): SeatSummary | undefined {
    const record = view.entries.findLast((entry) => entry.kind === SEAT_RECORD_KIND);
    if (record !== undefined) return (record.data as unknown as SeatRecord).next;
    return seatOfMeta(view.docs[CONVERSATION_META_KIND] as unknown as ConversationMeta | undefined);
}

/**
 * Follows what a watch has passed on: the newest entry id and the seat. `entriesAfterNewest` walks the view's entries
 * back from the end and stops at the first one whose id is at or below the newest passed on. It never looks for that
 * id itself, because a compaction can remove it.
 */
function createEntryTracker(attached: StructuralView) {
    let newestId = attached.entries.at(-1)?.id;
    let seat = seatAtAttachment(attached);
    return {
        newestEntryId: newestId === undefined ? null : String(newestId),
        entriesAfterNewest(view: StructuralView): WatchedEntry[] {
            const added: EntryRecord[] = [];
            for (let index = view.entries.length - 1; index >= 0; index--) {
                const entry = view.entries[index] as EntryRecord;
                if (newestId !== undefined && Number(entry.id) <= Number(newestId)) break;
                added.push(entry);
            }
            added.reverse();
            const last = added.at(-1);
            if (last !== undefined) newestId = last.id;
            return added.map((entry) => {
                if (entry.kind === SEAT_RECORD_KIND) seat = (entry.data as unknown as SeatRecord).next;
                const shown = toHostEntry(entry);
                return entry.kind === ASSISTANT_ENTRY_KIND && seat !== undefined ? { ...shown, seat } : shown;
            });
        },
    };
}

type CommitTracker = {
    conversations(): { id: string; busy: boolean }[];
    stop(): void;
};

/**
 * Follows the commits of the harness to know which conversations exist and which are busy. A conversation is busy
 * while it has a task that is not terminal, as in `HarnessHost.listConversations`. `onEvent` hears every change after
 * the tracker is returned.
 */
async function trackCommits(host: HarnessHost, onEvent: (event: InstanceEvent) => void): Promise<CommitTracker> {
    const harness = internalHarness(host);
    const liveTasks = new Map<ConversationId, Set<TaskId>>();
    const knownConversations = new Set<string>();
    let pendingChanges: CommitChange[] | undefined = [];
    let isStopped = false;

    const isConversationBusy = (id: ConversationId): boolean => (liveTasks.get(id)?.size ?? 0) > 0;

    function applyChanges(changes: readonly CommitChange[], shouldEmit: boolean): void {
        const busyBefore = new Map<ConversationId, boolean>();
        for (const change of changes) {
            if (change.type !== "conversation" || knownConversations.has(String(change.value.id))) continue;
            knownConversations.add(String(change.value.id));
            if (shouldEmit) onEvent({ type: "conversation_created", conversationId: String(change.value.id) });
        }
        for (const change of changes) {
            if (change.type !== "task") continue;
            const { id, conversationId, state } = change.value;
            if (!busyBefore.has(conversationId)) busyBefore.set(conversationId, isConversationBusy(conversationId));
            const tasks = liveTasks.get(conversationId) ?? new Set<TaskId>();
            if (state.status === "terminal") tasks.delete(id);
            else tasks.add(id);
            liveTasks.set(conversationId, tasks);
        }
        if (!shouldEmit) return;
        for (const [id, wasBusy] of busyBefore) {
            if (wasBusy === isConversationBusy(id)) continue;
            onEvent({ type: wasBusy ? "run_finished" : "run_started", conversationId: String(id) });
        }
    }

    // Subscribing before reading leaves no gap. Changes that arrive while reading are applied silently afterwards: the
    // read may or may not include them, and the last change of a task wins either way.
    const unsubscribe = harness.subscribeCommits((publication) => {
        if (isStopped) return;
        if (pendingChanges) pendingChanges.push(...publication.changes);
        else applyChanges(publication.changes, true);
    });
    try {
        for (const info of await host.listConversations()) {
            knownConversations.add(info.id);
        }
        for (const { record } of (await harness.inspect(context)).tasks) {
            const tasks = liveTasks.get(record.conversationId) ?? new Set<TaskId>();
            tasks.add(record.id);
            liveTasks.set(record.conversationId, tasks);
        }
    } catch (error) {
        unsubscribe();
        throw error;
    }
    applyChanges(pendingChanges, false);
    pendingChanges = undefined;

    const isBusy = (id: string): boolean => isConversationBusy(toConversationId(id));
    return {
        conversations: () => [...knownConversations].map((id) => ({ id, busy: isBusy(id) })),
        stop() {
            isStopped = true;
            unsubscribe();
        },
    };
}

/**
 * Watches one conversation. `snapshot` is where it stands at attachment; `onFrame` then runs once per commit that
 * touches it, in commit order, with the entries that commit added and nothing replayed.
 */
export async function watchConversation(
    host: HarnessHost,
    id: string,
    onFrame: (frame: ConversationFrame) => void,
): Promise<{ snapshot: ConversationSnapshot; stop(): Promise<void> }> {
    const harness = internalHarness(host);
    const numericId = parseConversationId(id);
    const conversation = numericId === undefined ? undefined : await harness.conversation(numericId, context);
    if (!conversation) throw new HostNotFoundError(`Conversation "${id}" does not exist.`);

    const watch = await conversation.watch(context);
    const tracker = createEntryTracker(watch.value);
    const snapshot = { newestEntryId: tracker.newestEntryId, ...toConversationView(watch.value) };
    let isStopped = false;
    watch.start(async (view) => {
        if (isStopped) return;
        onFrame({ view: toConversationView(view), entries: tracker.entriesAfterNewest(view) });
    });
    return {
        snapshot,
        async stop() {
            isStopped = true;
            await watch.stop();
        },
    };
}

/**
 * Watches the whole instance. `snapshot` lists every conversation with its busy state; `listener` then hears
 * conversations being created and runs starting and finishing.
 */
export async function watchInstance(
    host: HarnessHost,
    listener: (event: InstanceEvent) => void,
): Promise<{ snapshot: { conversations: { id: string; busy: boolean }[] }; stop(): void }> {
    const tracker = await trackCommits(host, listener);
    return { snapshot: { conversations: tracker.conversations() }, stop: () => tracker.stop() };
}

/**
 * Reports each committed write of a conversation's `intern.conversation` document, with the document's new value, in
 * commit order. A write of the unset placeholder, which no seated conversation keeps, is not reported. Nothing is
 * replayed: `listener` hears only commits after the call returns.
 */
export async function watchConversationMeta(
    host: HarnessHost,
    listener: (change: { conversationId: string; meta: ConversationMeta }) => void,
): Promise<{ stop(): void }> {
    let isStopped = false;
    const unsubscribe = internalHarness(host).subscribeCommits((publication) => {
        if (isStopped) return;
        for (const change of publication.changes) {
            if (change.type !== "document" || change.record.kind !== CONVERSATION_META_KIND) continue;
            if (change.conversationId === undefined || change.value === null) continue;
            const meta = change.value as unknown as ConversationMeta;
            if (meta.jobId === "") continue;
            listener({ conversationId: String(change.conversationId), meta });
        }
    });
    return {
        stop() {
            isStopped = true;
            unsubscribe();
        },
    };
}
