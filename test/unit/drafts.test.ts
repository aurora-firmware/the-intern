/**
 * The typed-text drafts (S-006 REQ-014, REQ-017): kept per page and box in the storage passed in, cleared after the
 * call succeeds, and held in memory when the storage throws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearDraft, type DraftStorage, loadDraft, saveDraft } from "../../web/ui/model/drafts.ts";

const memoryStorage = (): DraftStorage => {
    const items = new Map<string, string>();
    return {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, value),
        removeItem: (key) => void items.delete(key),
    };
};

const throwingStorage = (): DraftStorage => {
    const fail = (): never => {
        throw new Error("storage is unavailable");
    };
    return { getItem: fail, setItem: fail, removeItem: fail };
};

describe("drafts", () => {
    it("loads_saved_text_back_for_that_page_and_box_only", () => {
        const storage = memoryStorage();
        saveDraft(storage, "job-1", "reply", "hello");
        assert.equal(loadDraft(storage, "job-1", "reply"), "hello");
        assert.equal(loadDraft(storage, "job-1", "note"), null);
        assert.equal(loadDraft(storage, "job-2", "reply"), null);
    });

    it("loads_nothing_after_the_draft_is_cleared", () => {
        const storage = memoryStorage();
        saveDraft(storage, "job-1", "reply", "hello");
        saveDraft(storage, "job-1", "note", "keep");
        clearDraft(storage, "job-1", "reply");
        assert.equal(loadDraft(storage, "job-1", "reply"), null);
        assert.equal(loadDraft(storage, "job-1", "note"), "keep");
    });

    it("keeps_the_text_in_memory_when_the_storage_throws", () => {
        const storage = throwingStorage();
        saveDraft(storage, "mem-page", "reply", "typed");
        assert.equal(loadDraft(storage, "mem-page", "reply"), "typed");
        clearDraft(storage, "mem-page", "reply");
        assert.equal(loadDraft(storage, "mem-page", "reply"), null);
    });

    it("does_not_confuse_a_page_and_box_whose_names_join_to_the_same_text", () => {
        const storage = memoryStorage();
        saveDraft(storage, "a:b", "c", "one");
        assert.equal(loadDraft(storage, "a", "b:c"), null);
    });
});
