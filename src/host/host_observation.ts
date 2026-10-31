/**
 * Committed-change observation (S-002 component 8 input): the observation feed and admission watch conversations and
 * the instance through these functions, never through pi-durable. Listeners run synchronously inside pi-durable's
 * delivery and are never awaited, so a listener can't delay a commit; buffering is the feed's job.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange, ConversationId, EntryRecord, JsonObject, TaskId } from "@earendil-works/pi-durable";
import { HostNotFoundError } from "./conversation_control.ts";
import { type HarnessHost, type HostEntry, internalHarness, toHostEntry } from "./harness_host.ts";

const context = BACKGROUND_CONTEXT;

export type ConversationView = { entries: HostEntry[]; live: unknown; inbox: unknown; busy: boolean };
export type ConversationFrame = { view: ConversationView; ops: unknown[] };
export type InstanceEvent = {
    type: "conversation_created" | "run_started" | "run_finished";
    conversationId: string;
};

type StructuralView = { entries: readonly EntryRecord[]; docs: Readonly<Record<string, JsonObject>> };

function toConversationView(view: StructuralView, isBusy: boolean): ConversationView {
    return {
        entries: view.entries.map(toHostEntry),
        live: view.docs["pi.live"] ?? null,
        inbox: view.docs["pi.inbox"] ?? null,
        busy: isBusy,
    };
}

type CommitTracker = {
    conversations(): { id: string; busy: boolean }[];
    isBusy(id: string): boolean;
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

    const isBusy = (id: string): boolean => isConversationBusy(Number(id) as ConversationId);
    return {
        conversations: () => [...knownConversations].map((id) => ({ id, busy: isBusy(id) })),
        isBusy,
        stop() {
            isStopped = true;
            unsubscribe();
        },
    };
}

/**
 * Watches one conversation. `snapshot` is its view at attachment; `onFrame` then runs once per commit that touches it,
 * in commit order, with nothing replayed.
 */
export async function watchConversation(
    host: HarnessHost,
    id: string,
    onFrame: (frame: ConversationFrame) => void,
): Promise<{ snapshot: ConversationView; stop(): Promise<void> }> {
    const harness = internalHarness(host);
    const conversation = /^\d+$/.test(id)
        ? await harness.conversation(Number(id) as ConversationId, context)
        : undefined;
    if (!conversation) throw new HostNotFoundError(`Conversation "${id}" does not exist.`);

    const tracker = await trackCommits(host, () => {});
    let watch: Awaited<ReturnType<typeof conversation.watch>>;
    try {
        watch = await conversation.watch(context);
    } catch (error) {
        tracker.stop();
        throw error;
    }
    const snapshot = toConversationView(watch.value, tracker.isBusy(id));
    let isStopped = false;
    watch.start(async (view, ops) => {
        if (isStopped) return;
        onFrame({ view: toConversationView(view, tracker.isBusy(id)), ops: [...ops] });
    });
    return {
        snapshot,
        async stop() {
            isStopped = true;
            tracker.stop();
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
