import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { droppedMessages, type SentMessage, unsettledMessages } from "../../web/ui/model/desk_queue.ts";

const sent = (submissionId: string, text: string): SentMessage => ({ submissionId, text });

describe("the Front desk's sent messages", () => {
    const messages = [sent("s1", "first"), sent("s2", "second"), sent("s3", "third"), sent("s4", "fourth")];
    const states = new Map([
        ["s1", "done"],
        ["s2", "unanswered"],
        ["s3", "queued"],
        ["s4", "running"],
    ]);

    it("names only the sent messages whose state is unanswered as dropped", () => {
        assert.deepEqual(droppedMessages(messages, states), [sent("s2", "second")]);
    });

    it("names no message as dropped when the service has no state for it", () => {
        assert.deepEqual(droppedMessages([sent("s9", "unknown")], states), []);
    });

    it("keeps holding the messages that are queued or running, and lets go of done and unanswered ones", () => {
        assert.deepEqual(unsettledMessages(messages, states), [sent("s3", "third"), sent("s4", "fourth")]);
    });

    it("keeps holding a message whose state is not known yet", () => {
        assert.deepEqual(unsettledMessages([sent("s9", "unknown")], states), [sent("s9", "unknown")]);
    });
});
