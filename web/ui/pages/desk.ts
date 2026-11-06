/**
 * The Front desk page (S-006 REQ-008): the front desk's recent conversation, kept current by the shared stream, and a
 * box to send it messages. A message waits its turn when the front desk is busy (busy mode `followUp`). Stop ends only
 * the chat turn, so it asks for no confirmation; the messages still queued are dropped, and the page names those it
 * sent. The activity is `ConversationActivity` with no `controls`: this page draws its own Stop. Below it sits the
 * form that creates a job directly (REQ-008).
 */
import { Fragment, h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { ConversationActivity, listen } from "../components/activity.ts";
import { isConnected } from "../components/connection_banner.ts";
import { CreateJobForm } from "../components/create_job.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { DraftTextBox } from "../components/text_box.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import { droppedMessages, type SentMessage, unsettledMessages } from "../model/desk_queue.ts";
import { createDraftStore, loadDraft } from "../model/drafts.ts";
import { requestId } from "../model/request_id.ts";

const PAGE = "desk";
const BOX = "message";
const FRONT_DESK_ROLE = "front desk";
const drafts = createDraftStore(window.sessionStorage);

type Desk = { conversationId: string };
type Submitted = { submissionId?: string; held?: true };
type Reload = () => Promise<void>;

// A feed connection has no way to remove a listener, so it gets one that speaks to the mounted page.
let mountedReload: Reload | undefined;
const attachedFeeds = new WeakSet<FeedConnection>();

const attachFeed = (feed: FeedConnection) => {
    if (attachedFeeds.has(feed)) return;
    attachedFeeds.add(feed);
    feed.onInstanceSnapshot(() => void mountedReload?.());
};

/** Whether the front desk is answering, from the state its conversation's stream gives. */
const useIsBusy = (feed: FeedConnection | null | undefined, conversationId: string | undefined): boolean => {
    const [isBusy, setBusy] = useState(false);
    useEffect(() => {
        setBusy(false);
        if (!feed || conversationId === undefined) return;
        return listen(feed, (event) => {
            if (event.type === "conversation-snapshot" && event.conversationId === conversationId) {
                setBusy((event.snapshot as { busy: boolean }).busy);
            } else if (event.type === "conversation-delta" && event.conversationId === conversationId) {
                const view = (event.delta as { view?: { busy: boolean } }).view;
                if (view !== undefined) setBusy(view.busy);
            }
        });
    }, [feed, conversationId]);
    return isBusy;
};

const readStates = async (sent: readonly SentMessage[]): Promise<Map<string, string>> => {
    const states = new Map<string, string>();
    for (const { submissionId } of sent) {
        const { state } = (await pageClient().invoke("submissions.get", { submissionId })) as { state: string };
        states.set(submissionId, state);
    }
    return states;
};

/** The front desk's conversation, the box that sends it a message, and Stop. */
export const DeskPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const connected = useContext(isConnected);
    const [conversationId, setConversationId] = useState<string | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const [isCalling, setCalling] = useState(false);
    const [dropped, setDropped] = useState<SentMessage[]>([]);
    const sent = useRef<SentMessage[]>([]);
    const clearRef = useRef<(() => void) | null>(null);
    const isBusy = useIsBusy(feed, conversationId);

    useEffect(() => {
        // `undefined` means the tab is still connecting: asking the worker to follow comes before the read.
        if (feed === undefined) return;
        let isClosed = false;
        const reload: Reload = async () => {
            try {
                const desk = (await pageClient().invoke("desk.get")) as Desk;
                if (isClosed) return;
                feed?.follow([desk.conversationId]);
                setConversationId(desk.conversationId);
                setFailure(undefined);
            } catch (error) {
                if (!isClosed) setFailure({ error });
            }
        };
        mountedReload = reload;
        if (feed !== null) attachFeed(feed);
        void reload();
        return () => {
            isClosed = true;
            if (mountedReload === reload) mountedReload = undefined;
            feed?.follow([]);
        };
    }, [feed]);

    const call = async (action: () => Promise<void>) => {
        setCalling(true);
        setFailure(undefined);
        try {
            await action();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };

    const send = () =>
        call(async () => {
            const content = loadDraft(drafts, PAGE, BOX) ?? "";
            const answer = (await pageClient().invoke("conversations.submit", {
                conversationId,
                content,
                requestId: requestId(),
                busyMode: "followUp",
            })) as Submitted;
            if (answer.submissionId !== undefined)
                sent.current.push({ submissionId: answer.submissionId, text: content });
            setDropped([]);
            clearRef.current?.();
        });

    const stop = () =>
        call(async () => {
            const before = await readStates(sent.current);
            await pageClient().invoke("conversations.abort", { conversationId });
            const after = await readStates(sent.current);
            setDropped(droppedMessages(sent.current, before, after));
            sent.current = unsettledMessages(sent.current, after);
        });

    const conversation = h(
        "div",
        { class: "desk" },
        conversationId !== undefined
            ? h(ConversationActivity, { feed, conversationId, role: FRONT_DESK_ROLE, key: conversationId })
            : null,
        dropped.length > 0
            ? h(
                  "div",
                  { class: "desk-dropped", role: "status" },
                  h("p", null, "Stopped. These messages were dropped, not answered:"),
                  h("ul", null, ...dropped.map((message) => h("li", { key: message.submissionId }, message.text))),
              )
            : null,
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h("label", null, "Message", h(DraftTextBox, { page: PAGE, box: BOX, clearRef, store: drafts })),
        h(
            "button",
            {
                type: "button",
                class: "button desk-send",
                disabled: !connected || isCalling || conversationId === undefined,
                onClick: send,
            },
            "Send",
        ),
        isBusy
            ? h(
                  "button",
                  {
                      type: "button",
                      class: "button button-destructive desk-stop",
                      disabled: !connected || isCalling,
                      onClick: stop,
                  },
                  "Stop",
              )
            : null,
    );
    return h(Fragment, null, conversation, h(CreateJobForm, null));
};
