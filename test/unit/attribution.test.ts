import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeEntries } from "../../src/service/attribution.ts";

const developer = { role: "developer", model: "p/one", workspace: "/w" };
const reviewer = { role: "reviewer", model: "p/two", thinkingLevel: "low", workspace: "/w" };

const seatRecord = (id: string, next: typeof developer | typeof reviewer) => ({
    id,
    kind: "intern.seat",
    data: { previous: null, next, actor: { kind: "team_member", wayIn: "cli" } },
});
const assistant = (id: string) => ({ id, kind: "pi.assistant", data: [{ role: "assistant" }] });
const user = (id: string) => ({ id, kind: "pi.user", data: [{ role: "user" }] });

describe("attributeEntries", () => {
    it("gives an assistant entry the seat of the latest seat record before it", () => {
        const result = attributeEntries([seatRecord("1", developer), user("2"), assistant("3")]);

        assert.deepEqual(result[2]?.seat, developer);
    });

    it("switches the attributed seat at a seat change", () => {
        const result = attributeEntries([
            seatRecord("1", developer),
            assistant("2"),
            seatRecord("3", reviewer),
            assistant("4"),
        ]);

        assert.deepEqual(
            result.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.seat),
            [developer, reviewer],
        );
    });

    it("keeps the seat across a reset entry", () => {
        const result = attributeEntries([
            seatRecord("1", developer),
            { id: "2", kind: "pi.reset", data: [] },
            assistant("3"),
        ]);

        assert.deepEqual(result[2]?.seat, developer);
    });

    it("leaves an assistant entry without a seat when no seat record precedes it", () => {
        const [entry] = attributeEntries([assistant("1")]);

        assert.ok(entry);
        assert.equal("seat" in entry, false);
    });

    it("leaves entries that are not assistant entries unchanged", () => {
        const entries = [seatRecord("1", developer), user("2")];

        assert.deepEqual(attributeEntries(entries), entries);
    });
});
