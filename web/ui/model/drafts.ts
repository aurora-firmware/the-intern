/** The part of `Storage` the drafts use, so a test or a page passes its own. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The storage a page keeps drafts in, and the text held here while that storage throws (a full quota, a refusal). */
export type DraftStore = { storage: DraftStorage; held: Map<string, string> };

export const createDraftStore = (storage: DraftStorage): DraftStore => ({ storage, held: new Map() });

const draftKey = (page: string, box: string): string => JSON.stringify(["draft", page, box]);

export const loadDraft = (store: DraftStore, page: string, box: string): string | null => {
    const key = draftKey(page, box);
    const held = store.held.get(key);
    if (held !== undefined) {
        return held;
    }
    try {
        return store.storage.getItem(key);
    } catch {
        return null;
    }
};

export const saveDraft = (store: DraftStore, page: string, box: string, text: string): void => {
    const key = draftKey(page, box);
    try {
        store.storage.setItem(key, text);
        store.held.delete(key);
    } catch {
        store.held.set(key, text);
    }
};

export const clearDraft = (store: DraftStore, page: string, box: string): void => {
    const key = draftKey(page, box);
    store.held.delete(key);
    try {
        store.storage.removeItem(key);
    } catch {
        // The text was held here only, and that is already gone.
    }
};
