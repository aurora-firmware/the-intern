import { h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";
import { createDraftStore, loadDraft } from "../model/drafts.ts";
import { requestId } from "../model/request_id.ts";
import type { FeedState } from "./activity.ts";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";
import { DraftTextBox } from "./text_box.ts";

const BOX_PREFIX = "redirect";
const OFFERED_STATUSES: readonly string[] = ["running", "parked", "waiting for a worker thread"];
const FINISHED_STATUSES: readonly string[] = ["idle", "closed"];
const FINISHED_TEXT = "The agent has already finished.";
const redirects = createDraftStore(window.sessionStorage);

/** One call at a time: whether it is going, and what the service said when it refused. */
const useCall = () => {
    const [sending, setSending] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const run = async (call: () => Promise<unknown>): Promise<boolean> => {
        setSending(true);
        setFailure(undefined);
        try {
            await call();
            return true;
        } catch (error) {
            setFailure({ error });
            return false;
        } finally {
            setSending(false);
        }
    };
    return { sending, failure, run };
};

/**
 * Whether the run has ended. The feed's state says it is not busy for an idle conversation and for one parked for
 * reports alike, so a conversation that is not busy is asked for its status.
 */
const hasFinished = async (conversationId: string, state: FeedState): Promise<boolean> => {
    if (state.busy) return false;
    const listing = (await pageClient().invoke("conversations.get", { conversationId })) as { status: string };
    return FINISHED_STATUSES.includes(listing.status);
};

type StopProps = { conversationId: string; state: FeedState; onEngaged: (isEngaged: boolean) => void };

/** Stop with its confirmation. It tells `onEngaged` while the dialog is open or its answer is shown. */
const StopButton = ({ conversationId, state, onEngaged }: StopProps) => {
    const connected = useContext(isConnected);
    const dialog = useRef<HTMLDialogElement>(null);
    const [message, setMessage] = useState<string | undefined>(undefined);
    const [isOpen, setOpen] = useState(false);
    const { sending, failure, run } = useCall();
    const isEngaged = isOpen || sending || message !== undefined || failure !== undefined;
    useEffect(() => onEngaged(isEngaged), [isEngaged, onEngaged]);

    const confirm = async () => {
        dialog.current?.close();
        setMessage(undefined);
        await run(async () => {
            if (await hasFinished(conversationId, state)) setMessage(FINISHED_TEXT);
            else await pageClient().invoke("conversations.abort", { conversationId });
        });
    };

    return h(
        "div",
        { class: "stop" },
        h(
            "button",
            {
                type: "button",
                class: "button button-destructive stop-open",
                disabled: !connected || sending,
                onClick: () => {
                    dialog.current?.showModal();
                    setOpen(true);
                },
            },
            "Stop",
        ),
        h(
            "dialog",
            { ref: dialog, class: "stop-dialog", onClose: () => setOpen(false) },
            h("p", null, "Stop this agent? Whatever it is doing ends."),
            h(
                "div",
                { class: "actions" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "button button-secondary stop-cancel",
                        onClick: () => dialog.current?.close(),
                    },
                    "Keep running",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "button button-destructive stop-confirm",
                        disabled: !connected,
                        onClick: confirm,
                    },
                    "Stop",
                ),
            ),
        ),
        message !== undefined ? h("p", { class: "control-message", role: "status" }, message) : null,
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};

type RedirectProps = { number: string; conversationId: string };

/** Words for the agent to take after its current tool round; a conversation parked for reports holds them. */
const RedirectBox = ({ number, conversationId }: RedirectProps) => {
    const connected = useContext(isConnected);
    const clearRef = useRef<(() => void) | null>(null);
    const { sending, failure, run } = useCall();
    const page = `job/${number}`;
    const box = `${BOX_PREFIX}/${conversationId}`;

    const send = async () => {
        const content = loadDraft(redirects, page, box) ?? "";
        const isSent = await run(() =>
            pageClient().invoke("conversations.submit", {
                conversationId,
                content,
                requestId: requestId(),
                busyMode: "steer",
            }),
        );
        if (isSent) clearRef.current?.();
    };

    return h(
        "div",
        { class: "redirect" },
        h("label", null, "Redirect", h(DraftTextBox, { page, box, clearRef, store: redirects, disabled: !connected })),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h(
            "button",
            { type: "button", class: "button redirect-send", disabled: !connected || sending, onClick: send },
            "Send",
        ),
    );
};

/**
 * Whether the conversation is running or parked for reports. A run in the feed's state says it is running; a parked
 * conversation shows no run there, so the status is read again whenever the run starts or ends.
 */
const useIsOffered = (conversationId: string, isBusy: boolean): boolean => {
    const [status, setStatus] = useState<string | undefined>(undefined);
    useEffect(() => {
        let isClosed = false;
        pageClient()
            .invoke("conversations.get", { conversationId })
            .then((listing) => {
                if (!isClosed) setStatus((listing as { status: string }).status);
            })
            .catch(() => {
                if (!isClosed) setStatus(undefined);
            });
        return () => {
            isClosed = true;
        };
    }, [conversationId, isBusy]);
    return isBusy || (status !== undefined && OFFERED_STATUSES.includes(status));
};

type ControlsProps = { number: string; conversationId: string; state: FeedState };

/** Stop and Redirect for a running conversation of a job or one parked for reports (S-006 REQ-006). */
export const ConversationControls = ({ number, conversationId, state }: ControlsProps) => {
    const [isEngaged, setEngaged] = useState(false);
    const isOffered = useIsOffered(conversationId, state.busy);
    if (!isOffered && !isEngaged) return null;
    return h(
        "div",
        { class: "conversation-controls", "data-busy": String(state.busy) },
        h(StopButton, { conversationId, state, onEngaged: setEngaged }),
        h(RedirectBox, { number, conversationId }),
    );
};
