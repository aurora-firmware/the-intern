import { h } from "preact";
import { useState } from "preact/hooks";
import { clearDraft, createDraftStore, type DraftStore, loadDraft, saveDraft } from "../model/drafts.ts";

export type DraftTextBoxProps = {
    page: string;
    box: string;
    disabled?: boolean;
    /** Receives the function that empties the box and its draft; the caller uses it after a call succeeds. */
    clearRef?: { current: (() => void) | null };
    /** The store of the drafts; the page's `sessionStorage` when absent. */
    store?: DraftStore;
};

let pageStore: DraftStore | undefined;

const sessionStore = (): DraftStore => {
    pageStore ??= createDraftStore(window.sessionStorage);
    return pageStore;
};

/** A text box that keeps its text in `sessionStorage` per page and box, so a reload doesn't lose it. */
export const DraftTextBox = ({ page, box, disabled = false, clearRef, store = sessionStore() }: DraftTextBoxProps) => {
    const key = JSON.stringify([page, box]);
    const [typed, setTyped] = useState<{ key: string; text: string } | undefined>(undefined);
    // Text typed for another page or box no longer applies; the draft of this one is read when it first shows.
    const text = typed?.key === key ? typed.text : (loadDraft(store, page, box) ?? "");
    if (clearRef !== undefined) {
        clearRef.current = () => {
            setTyped({ key, text: "" });
            clearDraft(store, page, box);
        };
    }
    return h("textarea", {
        value: text,
        disabled,
        onInput: (event: Event) => {
            const next = (event.target as HTMLTextAreaElement).value;
            setTyped({ key, text: next });
            saveDraft(store, page, box, next);
        },
    });
};
