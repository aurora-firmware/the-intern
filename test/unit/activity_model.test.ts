/** The live activity model (S-006 REQ-005, REQ-014): merging entries, catching up, long output and held notices. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type ActivityEntry,
    catchUp,
    collapseOutput,
    type EntriesPage,
    type EntriesRead,
    heldNotice,
    mergeEntries,
    seatRole,
} from "../../web/ui/model/activity.ts";

const entry = (id: number, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
    id: String(id),
    kind: "pi.user",
    data: {},
    ...extra,
});

const idsOf = (entries: readonly ActivityEntry[]): string[] => entries.map((each) => each.id);

/** A conversation of entries 1..count, served newest first in pages like `conversations.entries`. */
const fakeConversation = (count: number) => {
    const reads: EntriesRead[] = [];
    const readPage = async (read: EntriesRead): Promise<EntriesPage> => {
        reads.push(read);
        const newestFirst = Array.from({ length: count }, (_, index) => entry(count - index));
        const start = read.after === undefined ? 0 : Number(read.after);
        const entries = newestFirst.slice(start, start + read.limit);
        const next = start + read.limit < count ? String(start + read.limit) : undefined;
        return next === undefined ? { entries } : { entries, next };
    };
    return { reads, readPage };
};

describe("mergeEntries", () => {
    it("keeps an entry that arrives by a read and by a delta once", () => {
        const merged = mergeEntries([entry(1), entry(2)], [entry(2), entry(3)]);
        assert.deepEqual(idsOf(merged), ["1", "2", "3"]);
    });

    it("orders entries by numeric id so that 10 follows 9", () => {
        const merged = mergeEntries([entry(10)], [entry(9), entry(2)]);
        assert.deepEqual(idsOf(merged), ["2", "9", "10"]);
    });

    it("leaves the entries it was given unchanged", () => {
        const known = [entry(2)];
        mergeEntries(known, [entry(1)]);
        assert.deepEqual(idsOf(known), ["2"]);
    });
});

describe("catchUp", () => {
    it("reads nothing when the snapshot's newest id matches the newest shown", async () => {
        const { reads, readPage } = fakeConversation(5);
        const result = await catchUp([entry(4), entry(5)], { newestEntryId: "5" }, readPage);
        assert.equal(reads.length, 0);
        assert.deepEqual(idsOf(result), ["4", "5"]);
    });

    it("reads nothing when the snapshot has no entry and none is shown", async () => {
        const { reads, readPage } = fakeConversation(0);
        const result = await catchUp([], { newestEntryId: null }, readPage);
        assert.equal(reads.length, 0);
        assert.deepEqual(result, []);
    });

    it("reads one page only, newest first, when nothing is shown", async () => {
        const { reads, readPage } = fakeConversation(2000);
        const result = await catchUp([], { newestEntryId: "2000" }, readPage);
        assert.deepEqual(reads, [{ order: "descending", limit: 200 }]);
        assert.equal(result.length, 200);
        assert.equal(result[0]?.id, "1801");
        assert.equal(result[199]?.id, "2000");
    });

    it("reads newest first until it reaches a known entry and adds what it missed once", async () => {
        const { reads, readPage } = fakeConversation(450);
        const known = Array.from({ length: 100 }, (_, index) => entry(index + 1));
        const result = await catchUp(known, { newestEntryId: "450" }, readPage);
        assert.equal(reads.length, 2);
        assert.deepEqual(reads[1], { order: "descending", limit: 200, after: "200" });
        assert.equal(result.length, 450);
        assert.equal(new Set(idsOf(result)).size, 450);
        assert.deepEqual(idsOf(result).slice(-2), ["449", "450"]);
    });

    it("stops after the first page when that page reaches a known entry", async () => {
        const { reads, readPage } = fakeConversation(300);
        const known = [entry(295), entry(296)];
        const result = await catchUp(known, { newestEntryId: "300" }, readPage);
        assert.equal(reads.length, 1);
        assert.deepEqual(idsOf(result), ["295", "296", "297", "298", "299", "300"]);
    });

    it("stops when the page has no next cursor, even with no known entry reached", async () => {
        const { reads, readPage } = fakeConversation(50);
        const result = await catchUp([entry(1000)], { newestEntryId: "1001" }, readPage);
        assert.equal(reads.length, 1);
        assert.equal(result.length, 51);
    });
});

describe("collapseOutput", () => {
    it("leaves a text of 20 lines whole", () => {
        const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
        assert.deepEqual(collapseOutput(text), { isCollapsed: false, shown: text });
    });

    it("collapses a text above 20 lines and shows its first lines", () => {
        const lines = Array.from({ length: 21 }, (_, index) => `line ${index}`);
        const result = collapseOutput(lines.join("\n"));
        assert.equal(result.isCollapsed, true);
        assert.ok(result.shown.startsWith("line 0\nline 1\n"));
        assert.ok(result.shown.split("\n").length < 21);
    });

    it("leaves a text of exactly 2 KiB whole", () => {
        const text = "x".repeat(2048);
        assert.equal(collapseOutput(text).isCollapsed, false);
    });

    it("collapses a text above 2 KiB, counting bytes, and keeps the shown part short", () => {
        const text = "é".repeat(1025);
        const result = collapseOutput(text);
        assert.equal(result.isCollapsed, true);
        assert.ok(new TextEncoder().encode(result.shown).length < 2048);
    });

    it("does not count a trailing newline as a line", () => {
        const text = `${Array.from({ length: 20 }, () => "a").join("\n")}\n`;
        assert.equal(collapseOutput(text).isCollapsed, false);
    });
});

describe("heldNotice", () => {
    it("reads an intern.steer record with no content as held until it continues", () => {
        const held = entry(3, { kind: "intern.steer", data: { actor: { type: "team_member" }, mode: "steer" } });
        assert.equal(heldNotice(held), "held until it continues");
    });

    it("gives no notice for the delivered intern.steer entry, which shows the words", () => {
        const delivered = entry(4, { kind: "intern.steer", data: { mode: "steer", content: "look at the logs" } });
        assert.equal(heldNotice(delivered), undefined);
    });

    it("gives no notice for another kind of entry", () => {
        assert.equal(heldNotice(entry(5)), undefined);
    });
});

describe("seatRole", () => {
    const seatEntry = (id: number, role: string): ActivityEntry =>
        entry(id, { kind: "intern.seat", data: { previous: null, next: { role } } });

    it("gives nothing when no entry is a seat record", () => {
        assert.equal(seatRole([entry(1), entry(2)]), undefined);
    });

    it("gives the role of the only seat record", () => {
        assert.equal(seatRole([entry(1), seatEntry(2, "gp")]), "gp");
    });

    it("gives the role of the newest seat record, comparing ids as numbers", () => {
        assert.equal(seatRole([seatEntry(9, "gp"), seatEntry(10, "bob"), seatEntry(2, "old")]), "bob");
    });
});
