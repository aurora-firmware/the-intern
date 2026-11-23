import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConversationId, toConversationId } from "../../src/host/conversation_id.ts";

describe("parseConversationId", () => {
    it("reads the canonical spelling of an id", () => {
        assert.equal(parseConversationId("7"), 7);
        assert.equal(parseConversationId("0"), 0);
        assert.equal(parseConversationId("1234"), 1234);
    });

    it("names no conversation for any other spelling of a number", () => {
        for (const text of ["07", "00", "007", "", " 7", "7 ", "-7", "+7", "7.0", "1e3", "0x7", "abc"]) {
            assert.equal(parseConversationId(text), undefined, JSON.stringify(text));
        }
    });

    it("names no conversation for digits that do not survive a round trip through a number", () => {
        assert.equal(parseConversationId("99999999999999999999"), undefined);
    });
});

describe("toConversationId", () => {
    it("throws for text that is not a canonical id", () => {
        assert.throws(() => toConversationId("07"), /"07" is not a conversation id/);
    });
});
