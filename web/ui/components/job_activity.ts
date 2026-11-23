/**
 * The sections of a job's conversations (S-006 REQ-005): the lead and every conversation it invokes, recursively. A
 * tab asks the worker to follow a conversation before its section reads (ADR-007 decision 3).
 */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import { type Controls, ConversationActivity, failureText, listen, NO_ROLE } from "./activity.ts";

type Member = { id: string; role: string };
type Tree = { id: string; role: string | null; invoked: Tree[] };
type Listing = { id: string; jobId: string | null; seat: { role: string } | null };
type Delta = { type: string; conversationId?: string };

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
