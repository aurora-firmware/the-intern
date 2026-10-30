import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createFakeModel, type FakeTranscript } from "../support/fake_model.ts";

type FakeModel = ReturnType<typeof createFakeModel>;
const created: FakeModel[] = [];

function makeModel(reply: (transcript: FakeTranscript) => string): FakeModel {
    const fake = createFakeModel(reply);
    created.push(fake);
    return fake;
}

async function ask(fake: FakeModel, text: string): Promise<string> {
    const answer = await completeSimple(fake.getModel(), {
        messages: [{ role: "user", content: text, timestamp: 0 }],
    });
    return answer.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

const describeTranscript = (transcript: FakeTranscript): string =>
    transcript.map((entry) => `${entry.role}:${entry.text}`).join("|");

afterEach(() => {
    for (const fake of created.splice(0)) fake.unregister();
});

describe("createFakeModel", () => {
    it("answers with the reply function applied to the transcript", async () => {
        const fake = makeModel(describeTranscript);
        assert.equal(await ask(fake, "hello"), "user:hello");
    });

    it("returns identical answers when the same transcript is sent twice", async () => {
        const fake = makeModel(describeTranscript);
        assert.equal(await ask(fake, "same"), await ask(fake, "same"));
    });

    it("keeps answering after many calls instead of running out of scripted replies", async () => {
        const fake = makeModel(describeTranscript);
        for (let call = 0; call < 5; call++) await ask(fake, "again");
        assert.equal(await ask(fake, "again"), "user:again");
    });

    it("returns the same answer from a new model after the first is discarded", async () => {
        const reply = describeTranscript;
        const first = makeModel(reply);
        const before = await ask(first, "restart me");
        first.unregister();
        const second = makeModel(reply);
        assert.equal(await ask(second, "restart me"), before);
    });

    it("gives different answers for different transcripts", async () => {
        const fake = makeModel(describeTranscript);
        assert.notEqual(await ask(fake, "one"), await ask(fake, "two"));
    });
});
