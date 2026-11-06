import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import { clearDraft, loadDraft, saveDraft } from "../model/drafts.ts";

export type DraftTextBoxProps = {
    page: string;
    box: string;
    disabled?: boolean;
    /** Receives the function that empties the box and its draft; the caller uses it after a call succeeds. */
    clearRef?: { current: (() => void) | null };
};

/** A text box that keeps its text in `sessionStorage` per page and box, so a reload doesn't lose it. */
export const DraftTextBox = ({ page, box, disabled = false, clearRef }: DraftTextBoxProps) => {
    const [text, setText] = useState(() => loadDraft(window.sessionStorage, page, box) ?? "");
    const clearOnce = useRef(() => {
        setText("");
        clearDraft(window.sessionStorage, page, box);
    });
    if (clearRef !== undefined) {
        clearRef.current = clearOnce.current;
    }
    return h("textarea", {
        value: text,
        disabled,
        onInput: (event: Event) => {
            const next = (event.target as HTMLTextAreaElement).value;
            setText(next);
            saveDraft(window.sessionStorage, page, box, next);
        },
    });
};
