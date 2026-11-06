import { h } from "preact";
import { useContext, useRef, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";
import { createDraftStore, loadDraft } from "../model/drafts.ts";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";
import { DraftTextBox } from "./text_box.ts";

const BOX = "answer";
const answers = createDraftStore(window.sessionStorage);

/**
 * The form that answers a Blocked job through `jobs.resume` (S-006 REQ-004). The draft is keyed by the job's address.
 * It clears after the service accepts the answer. When the service refuses, the text stays and so does the form, even
 * if the job has stopped being Blocked meanwhile: the service decides what is allowed, and the typed text isn't lost.
 */
export const AnswerBox = ({ number, isBlocked }: { number: string; isBlocked: boolean }) => {
    const connected = useContext(isConnected);
    const clearRef = useRef<(() => void) | null>(null);
    const [sending, setSending] = useState(false);
    const [failure, setFailure] = useState<{ number: string; error: unknown } | undefined>(undefined);
    const [, typedAgain] = useState(0);
    const page = `job/${number}`;
    const hasText = (loadDraft(answers, page, BOX) ?? "") !== "";
    if (!isBlocked && !hasText) return null;

    const send = async () => {
        const text = loadDraft(answers, page, BOX) ?? "";
        setSending(true);
        setFailure(undefined);
        try {
            await pageClient().invoke("jobs.resume", { job: number, text });
            clearRef.current?.();
        } catch (error) {
            setFailure({ number, error });
        } finally {
            setSending(false);
        }
    };

    return h(
        "section",
        { class: "answer", onInput: () => typedAgain((count) => count + 1) },
        h("h3", null, "Answer"),
        h(DraftTextBox, { page, box: BOX, clearRef, store: answers }),
        failure?.number === number ? h(RefusalMessage, { error: failure.error }) : null,
        h("button", { type: "button", class: "button", disabled: !connected || sending, onClick: send }, "Send"),
    );
};
