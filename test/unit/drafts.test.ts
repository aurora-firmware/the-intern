/**
 * The typed-text drafts (S-006 REQ-014, REQ-017): kept per page and box in the storage passed in, cleared after the
 * call succeeds, and held in memory when the storage throws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h, render } from "preact";
import { DraftTextBox, type DraftTextBoxProps } from "../../web/ui/components/text_box.ts";
import {
    clearDraft,
    createDraftStore,
    type DraftStorage,
    type DraftStore,
    loadDraft,
    saveDraft,
} from "../../web/ui/model/drafts.ts";

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

const memoryStore = (): DraftStore => createDraftStore(memoryStorage());

describe("drafts", () => {
    it("loads_saved_text_back_for_that_page_and_box_only", () => {
        const store = memoryStore();
        saveDraft(store, "job-1", "reply", "hello");
        assert.equal(loadDraft(store, "job-1", "reply"), "hello");
        assert.equal(loadDraft(store, "job-1", "note"), null);
        assert.equal(loadDraft(store, "job-2", "reply"), null);
    });

    it("loads_nothing_after_the_draft_is_cleared", () => {
        const store = memoryStore();
        saveDraft(store, "job-1", "reply", "hello");
        saveDraft(store, "job-1", "note", "keep");
        clearDraft(store, "job-1", "reply");
        assert.equal(loadDraft(store, "job-1", "reply"), null);
        assert.equal(loadDraft(store, "job-1", "note"), "keep");
    });

    it("keeps_the_text_in_memory_when_the_storage_throws", () => {
        const store = createDraftStore(throwingStorage());
        saveDraft(store, "job-1", "reply", "typed");
        assert.equal(loadDraft(store, "job-1", "reply"), "typed");
        clearDraft(store, "job-1", "reply");
        assert.equal(loadDraft(store, "job-1", "reply"), null);
    });

    it("shares_no_held_text_between_two_stores", () => {
        saveDraft(createDraftStore(throwingStorage()), "job-1", "reply", "typed");
        assert.equal(loadDraft(createDraftStore(throwingStorage()), "job-1", "reply"), null);
    });

    it("does_not_confuse_a_page_and_box_whose_names_join_to_the_same_text", () => {
        const store = memoryStore();
        saveDraft(store, "a:b", "c", "one");
        assert.equal(loadDraft(store, "a", "b:c"), null);
    });
});

/** Just enough of a document for Preact to build and update a text area. */
class FakeNode {
    nodeType = 1;
    childNodes: FakeNode[] = [];
    parentNode: FakeNode | null = null;
    props: Record<string, unknown> = {};
    listeners = new Map<string, (this: FakeNode, event: unknown) => void>();
    style = {};
    namespaceURI = "http://www.w3.org/1999/xhtml";
    localName: string;
    constructor(localName: string) {
        this.localName = localName;
    }
    get nodeName(): string {
        return this.localName.toUpperCase();
    }
    get firstChild(): FakeNode | null {
        return this.childNodes[0] ?? null;
    }
    get nextSibling(): FakeNode | null {
        return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null;
    }
    appendChild(child: FakeNode): FakeNode {
        return this.insertBefore(child, null);
    }
    insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        const at = before === null ? -1 : this.childNodes.indexOf(before);
        this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
        return child;
    }
    removeChild(child: FakeNode): FakeNode {
        this.childNodes.splice(this.childNodes.indexOf(child), 1);
        child.parentNode = null;
        return child;
    }
    setAttribute(name: string, value: unknown): void {
        this.props[name] = value;
    }
    removeAttribute(name: string): void {
        delete this.props[name];
    }
    addEventListener(name: string, listener: (this: FakeNode, event: unknown) => void): void {
        this.listeners.set(name, listener);
    }
    removeEventListener(name: string): void {
        this.listeners.delete(name);
    }
}

const installFakeDocument = (): void => {
    Object.assign(globalThis, {
        document: {
            createElementNS: (_namespace: string, name: string) => new FakeNode(name),
            createTextNode: (data: string) => Object.assign(new FakeNode("#text"), { nodeType: 3, data }),
        },
    });
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const mount = (props: DraftTextBoxProps) => {
    installFakeDocument();
    const root = new FakeNode("div");
    const show = (next: DraftTextBoxProps) => render(h(DraftTextBox, next), root as unknown as Element);
    show(props);
    const area = (): FakeNode => root.childNodes[0] as FakeNode;
    const type = async (text: string) => {
        area()
            .listeners.get("input")
            ?.call(area(), { type: "input", target: { value: text } });
        await settle();
    };
    return { show, area, type };
};

describe("DraftTextBox", () => {
    it("fills_the_box_from_the_draft_and_saves_what_is_typed", async () => {
        const store = memoryStore();
        saveDraft(store, "job-1", "reply", "kept");
        const { area, type } = mount({ page: "job-1", box: "reply", store });
        assert.equal(area().props.value, "kept");
        await type("more");
        assert.equal(loadDraft(store, "job-1", "reply"), "more");
    });

    it("is_disabled_while_the_caller_says_so", () => {
        const { area } = mount({ page: "job-1", box: "reply", store: memoryStore(), disabled: true });
        assert.equal(area().props.disabled, true);
    });

    it("empties_the_box_and_its_draft_through_clear", async () => {
        const store = memoryStore();
        const clearRef: DraftTextBoxProps["clearRef"] = { current: null };
        const { area, type } = mount({ page: "job-1", box: "reply", store, clearRef });
        await type("sent");
        clearRef.current?.();
        await settle();
        assert.equal(area().props.value, "");
        assert.equal(loadDraft(store, "job-1", "reply"), null);
    });

    it("shows_the_draft_of_the_new_page_and_clears_that_one_after_a_change_of_page", async () => {
        const store = memoryStore();
        saveDraft(store, "job-1", "reply", "first");
        saveDraft(store, "job-2", "reply", "second");
        const clearRef: DraftTextBoxProps["clearRef"] = { current: null };
        const { show, area } = mount({ page: "job-1", box: "reply", store, clearRef });
        show({ page: "job-2", box: "reply", store, clearRef });
        await settle();
        assert.equal(area().props.value, "second");
        clearRef.current?.();
        assert.equal(loadDraft(store, "job-2", "reply"), null);
        assert.equal(loadDraft(store, "job-1", "reply"), "first");
    });
});
