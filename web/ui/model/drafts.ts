/** The part of `Storage` the drafts use, so a test or a page passes its own. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Text held while the storage throws (a private window, a full quota); it is lost with the page. */
const memoryDrafts = new Map<string, string>();

const draftKey = (page: string, box: string): string => JSON.stringify(["draft", page, box]);

export const loadDraft = (storage: DraftStorage, page: string, box: string): string | null => {
    const key = draftKey(page, box);
    const held = memoryDrafts.get(key);
    if (held !== undefined) {
        return held;
    }
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
};

export const saveDraft = (storage: DraftStorage, page: string, box: string, text: string): void => {
    const key = draftKey(page, box);
    try {
        storage.setItem(key, text);
        memoryDrafts.delete(key);
    } catch {
        memoryDrafts.set(key, text);
    }
};

export const clearDraft = (storage: DraftStorage, page: string, box: string): void => {
    const key = draftKey(page, box);
    memoryDrafts.delete(key);
    try {
        storage.removeItem(key);
    } catch {
        // The text was held in memory only, and that is already gone.
    }
};
