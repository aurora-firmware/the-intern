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
type Member = { id: string; role: string };
type Tree = { id: string; role: string | null; invoked: Tree[] };
type Listing = { id: string; jobId: string | null; seat: { role: string } | null };

const FIRST_PAGE: EntriesRead = { order: "descending", limit: 200 };
const NO_ROLE = "agent";
const TEXT_STYLE = "margin: 0; overflow-wrap: anywhere; white-space: pre-wrap;";
const LIST_STYLE = "display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none;";
const BYTES_PER_KIB = 1024;

const listeners = new WeakMap<FeedConnection, Set<(event: FeedEvent) => void>>();

/** A feed connection has no way to remove a listener, so each gets one that passes events to the mounted sections. */
const listen = (feed: FeedConnection, listener: (event: FeedEvent) => void): (() => void) => {
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
const failureText = (error: unknown): string | undefined => {
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
                catchUp(known.current, snapshot, readPage).then(merge, fail);
            } else if (event.type === "conversation-delta" && event.conversationId === conversationId) {
                const delta = event.delta as Delta;
                if (delta.view !== undefined) setState({ busy: delta.view.busy, live: delta.view.live });
                merge(delta.entries ?? []);
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
        h("summary", null, role),
        failure !== undefined ? h("div", { class: "error", role: "alert" }, failure) : null,
        h("ul", { style: LIST_STYLE }, ...entries.map((entry) => h(EntryItems, { entry, key: entry.id }))),
        answer !== "" ? h("p", { class: "activity-live", style: TEXT_STYLE }, answer) : null,
        controls?.(conversationId, state) ?? null,
    );
};

const flatten = (tree: Tree): Member[] => [
    { id: tree.id, role: tree.role ?? NO_ROLE },
    ...tree.invoked.flatMap(flatten),
];

type JobActivityProps = {
    feed: FeedConnection | null | undefined;
    /** The job's id, which `conversations.get` names in `jobId`. */
    jobId: string;
    leadConversation: string | undefined;
    controls?: Controls;
};

/** The sections of a job's conversations: the lead and every conversation it invokes, recursively. */
export const JobActivity = ({ feed, jobId, leadConversation, controls }: JobActivityProps) => {
    const [members, setMembers] = useState<Member[]>([]);
    const [failure, setFailure] = useState<string | undefined>();

    useEffect(() => {
        if (!feed) return;
        const held = new Map<string, Member>();
        let isClosed = false;
        const fail = (error: unknown) => {
            if (!isClosed) setFailure(failureText(error));
        };
        // Following comes first: the section reads its entries only once it is drawn (ADR-007 decision 3).
        const admit = (found: Member[]) => {
            const fresh = found.filter((member) => !held.has(member.id));
            if (isClosed || fresh.length === 0) return;
            for (const member of fresh) held.set(member.id, member);
            feed.follow([...held.keys()]);
            setMembers([...held.values()]);
        };
        const readTree = async () => {
            if (leadConversation === undefined) return;
            const tree = await pageClient().invoke("conversations.invocations", { conversationId: leadConversation });
            admit(flatten(tree as Tree));
        };
        const admitCreated = async (conversationId: string) => {
            const listing = (await pageClient().invoke("conversations.get", { conversationId })) as Listing;
            if (listing.jobId === jobId) admit([{ id: listing.id, role: listing.seat?.role ?? NO_ROLE }]);
        };
        const unlisten = listen(feed, (event) => {
            const delta = event.type === "instance-delta" ? (event.delta as Delta) : undefined;
            if (delta?.type === "conversation_created" && delta.conversationId !== undefined) {
                admitCreated(delta.conversationId).catch(fail);
            } else if (event.type === "instance-snapshot") {
                readTree().catch(fail);
            }
        });
        readTree().catch(fail);
        return () => {
            isClosed = true;
            unlisten();
            feed.follow([]);
        };
    }, [feed, jobId, leadConversation]);

    return h(
        "section",
        { class: "job-activity", "data-section": "activity" },
        h("h3", null, "Activity"),
        failure !== undefined ? h("div", { class: "error", role: "alert" }, failure) : null,
        ...members.map((member) =>
            h(ConversationActivity, {
                feed,
                conversationId: member.id,
                role: member.role,
                key: member.id,
                ...(controls !== undefined && { controls }),
            }),
        ),
    );
};
