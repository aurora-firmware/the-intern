/**
 * The live activity of a conversation (S-006 REQ-005): its stored entries, then what the conversation stream adds. A
 * section follows one conversation, and `JobActivity` holds one section for the lead of a job and for every
 * conversation it invokes, recursively. A tab asks the worker to follow a conversation before it reads (ADR-007
 * decision 3), merges entries by id and catches up after a new stream (decision 4).
 */
import { type ComponentChild, h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ClientError, UnreachableError } from "../client/client.ts";
import { type FeedConnection, type FeedEvent, pageClient } from "../feed_connection.ts";
import {
    type ActivityEntry,
    type ActivitySnapshot,
    catchUp,
    collapseOutput,
    type EntriesPage,
    type EntriesRead,
    heldNotice,
    mergeEntries,
    seatRole,
} from "../model/activity.ts";

/** What a conversation's feed state says: whether a run is going on, and the answer being written. */
export type FeedState = { busy: boolean; live: unknown };
/** What to draw in a conversation's section besides its entries; the Job page passes it, the Front desk doesn't. */
export type Controls = (conversationId: string, state: FeedState) => ComponentChild;

type Part = { type?: string; text?: string; name?: string; arguments?: unknown };
type Message = { content?: unknown; toolName?: string; isError?: boolean };
type Delta = {
    type: string;
    conversationId?: string;
    entries?: ActivityEntry[];
    view?: { live: unknown; busy: boolean };
};

const FIRST_PAGE: EntriesRead = { order: "descending", limit: 200 };
export const NO_ROLE = "agent";
const TEXT_STYLE = "margin: 0; overflow-wrap: anywhere; white-space: pre-wrap;";
const LIST_STYLE = "display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none;";
const BYTES_PER_KIB = 1024;

const listeners = new WeakMap<FeedConnection, Set<(event: FeedEvent) => void>>();

/** A feed connection has no way to remove a listener, so each gets one that passes events to the mounted sections. */
export const listen = (feed: FeedConnection, listener: (event: FeedEvent) => void): (() => void) => {
    let held = listeners.get(feed);
    if (held === undefined) {
        const set = new Set<(event: FeedEvent) => void>();
        held = set;
        listeners.set(feed, set);
        feed.onEvent((event) => {
            for (const each of [...set]) each(event);
        });
    }
    held.add(listener);
    return () => void held.delete(listener);
};

/** A refusal or failure worth telling the team member; a service that can't be reached shows the banner instead. */
export const failureText = (error: unknown): string | undefined => {
    if (error instanceof UnreachableError || (error instanceof ClientError && error.code === "unavailable")) {
        return undefined;
    }
    return error instanceof Error ? error.message : String(error);
};

const messagesOf = (data: unknown): Message[] => (Array.isArray(data) ? (data as Message[]) : []);
const partsOf = (message: Message): Part[] =>
    typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as Part[])
          : [];
const textOf = (message: Message): string =>
    partsOf(message)
        .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n");

/** Long output shows its first lines and a button for the rest; the full text enters the DOM only when expanded. */
const Output = ({ text }: { text: string }) => {
    const [isExpanded, setExpanded] = useState(false);
    const { isCollapsed, shown } = collapseOutput(text);
    if (!isCollapsed || isExpanded) return h("pre", { class: "output", style: TEXT_STYLE }, text);
    const kib = Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_KIB);
    return [
        h("pre", { class: "output output-collapsed", style: TEXT_STYLE }, shown),
        h(
            "button",
            { type: "button", class: "output-more", onClick: () => setExpanded(true) },
            `Show more (${kib} KiB in all)`,
        ),
    ];
};

type Box = { kind: string; label: string; body: ComponentChild[] };

const toolCall = (part: Part) =>
    h(
        "div",
        { class: "activity-tool-call" },
        h("span", { class: "caption" }, "Tool call"),
        h(Output, { text: `${part.name ?? "tool"} ${JSON.stringify(part.arguments ?? {})}` }),
    );

type Seating = { role: string; model: string; workspace: string };

/** A seat change names the previous and the new role. A conversation's first seat record has no previous and stays undrawn. */
const seatBoxes = (entry: ActivityEntry): Box[] => {
    const { previous, next } = (entry.data ?? {}) as { previous?: Seating | null; next?: Seating };
    if (previous === null || previous === undefined || next === undefined) return [];
    const text = `${next.role} on ${next.model} in ${next.workspace}`;
    return [{ kind: "seat", label: `Seat changed from ${previous.role} to ${next.role}`, body: [h(Output, { text })] }];
};

/** What an entry draws: one box per message of a tool result, one for the other kinds, none for the rest. */
const boxesOf = (entry: ActivityEntry): Box[] => {
    const messages = messagesOf(entry.data);
    const { actor, content } = (entry.data ?? {}) as { actor?: { role?: string }; content?: unknown };
    switch (entry.kind) {
        case "pi.user":
            return [{ kind: "user", label: "Input", body: [h(Output, { text: messages.map(textOf).join("\n") })] }];
        case "pi.assistant": {
            const parts = messages.flatMap(partsOf);
            const body = parts.flatMap((part) =>
                part.type === "text"
                    ? [h(Output, { text: part.text ?? "" })]
                    : part.type === "toolCall"
                      ? [toolCall(part)]
                      : [],
            );
            return [{ kind: "assistant", label: "Answer", body }];
        }
        case "pi.tool-result":
            return messages.map((message) => ({
                kind: "tool-result",
                label: `${message.toolName ?? "tool"} ${message.isError ? "failed" : "returned"}`,
                body: [h(Output, { text: textOf(message) })],
            }));
        case "intern.report":
            return [
                {
                    kind: "report",
                    label: `Report from ${actor?.role ?? NO_ROLE}`,
                    body: [h(Output, { text: String(content ?? "") })],
                },
            ];
        case "intern.steer": {
            const text = heldNotice(entry) ?? (typeof content === "string" ? content : undefined);
            return text === undefined ? [] : [{ kind: "steer", label: "Input", body: [h(Output, { text })] }];
        }
        case "intern.seat":
            return seatBoxes(entry);
        case "pi.compaction":
            return [{ kind: "compaction", label: "Compacted", body: [] }];
        case "pi.reset":
            return [{ kind: "reset", label: "Reset", body: [] }];
        default:
            return [];
    }
};

const EntryItems = ({ entry }: { entry: ActivityEntry }) =>
    boxesOf(entry).map((box) =>
        h(
            "li",
            { class: `card activity-entry activity-${box.kind}`, "data-entry-id": entry.id, "data-kind": entry.kind },
            h("span", { class: "caption" }, box.label),
            ...box.body,
        ),
    );

const partialAnswer = (live: unknown): string => {
    const message = (live as { generation?: { message?: Message } } | null)?.generation?.message;
    return message === undefined ? "" : textOf(message);
};

type SectionProps = {
    feed: FeedConnection | null | undefined;
    conversationId: string;
    role: string;
    controls?: Controls;
};

/** One conversation's section: its entries, the answer being written, and what `controls` draws. */
export const ConversationActivity = ({ feed, conversationId, role, controls }: SectionProps) => {
    const [entries, setEntries] = useState<ActivityEntry[]>([]);
    const [state, setState] = useState<FeedState>({ busy: false, live: null });
    const [failure, setFailure] = useState<string | undefined>();
    const known = useRef<ActivityEntry[]>([]);
    const wasBusy = useRef(false);

    useEffect(() => {
        if (!feed) return;
        let isClosed = false;
        const fail = (error: unknown) => {
            if (!isClosed) setFailure(failureText(error));
        };
        const merge = (added: readonly ActivityEntry[]) => {
            known.current = mergeEntries(known.current, added);
            if (!isClosed) setEntries(known.current);
        };
        const readPage = async (read: EntriesRead) =>
            (await pageClient().invoke("conversations.entries", { conversationId, ...read })) as EntriesPage;
        const unlisten = listen(feed, (event) => {
            if (event.type === "conversation-snapshot" && event.conversationId === conversationId) {
                const snapshot = event.snapshot as ActivitySnapshot & FeedState;
                setState({ busy: snapshot.busy, live: snapshot.live });
                wasBusy.current = snapshot.busy;
                catchUp(known.current, snapshot, readPage).then(merge, fail);
            } else if (event.type === "conversation-delta" && event.conversationId === conversationId) {
                const delta = event.delta as Delta;
                if (delta.view !== undefined) setState({ busy: delta.view.busy, live: delta.view.live });
                merge(delta.entries ?? []);
                // A compaction is listed as live work until it ends, and the entry it adds comes in no delta, so the
                // end of work reads the newest entries again.
                if (delta.view !== undefined) {
                    const hasEnded = wasBusy.current && !delta.view.busy;
                    wasBusy.current = delta.view.busy;
                    if (hasEnded) readPage(FIRST_PAGE).then((page) => merge(page.entries), fail);
                }
            }
        });
        // The page asked the worker to follow before it drew this section, so what is read now meets the stream by id.
        readPage(FIRST_PAGE).then((page) => merge(page.entries), fail);
        return () => {
            isClosed = true;
            unlisten();
        };
    }, [feed, conversationId]);

    const answer = state.busy ? partialAnswer(state.live) : "";
    return h(
        "details",
        { class: "activity", open: true, "data-conversation": conversationId },
        h("summary", null, seatRole(entries) ?? role),
        failure !== undefined ? h("div", { class: "error", role: "alert" }, failure) : null,
        h("ul", { style: LIST_STYLE }, ...entries.map((entry) => h(EntryItems, { entry, key: entry.id }))),
        answer !== "" ? h("p", { class: "activity-live", style: TEXT_STYLE }, answer) : null,
        controls?.(conversationId, state) ?? null,
    );
};
