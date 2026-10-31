import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createFakeModel, type FakeReply, type FakeTranscript } from "../support/fake_model.ts";

type FakeModel = ReturnType<typeof createFakeModel>;
const created: FakeModel[] = [];

type DelayMs = (transcript: FakeTranscript) => number;

function makeModel(reply: (transcript: FakeTranscript) => FakeReply, delayMs?: DelayMs): FakeModel {
    const fake = createFakeModel(reply, delayMs ? { delayMs } : undefined);
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

describe("createFakeModel tool calls", () => {
    const callEcho = (): FakeReply => ({ toolCall: { name: "echo", arguments: { word: "hi" } } });

    function toolCallsIn(answer: Awaited<ReturnType<typeof completeSimple>>) {
        return answer.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
    }

    it("answers with an assistant message that calls the tool when reply returns a toolCall", async () => {
        const fake = makeModel(callEcho);
        const answer = await completeSimple(fake.getModel(), {
            messages: [{ role: "user", content: "go", timestamp: 0 }],
        });
        const calls = toolCallsIn(answer);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.name, "echo");
        assert.deepEqual(calls[0]?.arguments, { word: "hi" });
        assert.equal(answer.stopReason, "toolUse");
    });

    it("answers with text after the tool when the transcript ends in a toolResult", async () => {
        const fake = makeModel((transcript) =>
            transcript.at(-1)?.role === "toolResult" ? `done:${transcript.at(-1)?.text}` : callEcho(),
        );
        const answer = await completeSimple(fake.getModel(), {
            messages: [
                { role: "user", content: "go", timestamp: 0 },
                {
                    role: "toolResult",
                    toolCallId: "call-1",
                    toolName: "echo",
                    content: [{ type: "text", text: "hi" }],
                    isError: false,
                    timestamp: 0,
                },
            ],
        });
        assert.equal(toolCallsIn(answer).length, 0);
        assert.deepEqual(answer.content, [{ type: "text", text: "done:hi" }]);
    });

    it("gives the same tool call from a new model with the same reply and transcript", async () => {
        const context = { messages: [{ role: "user" as const, content: "go", timestamp: 0 }] };
        const first = makeModel(callEcho);
        const before = toolCallsIn(await completeSimple(first.getModel(), context));
        first.unregister();
        const second = makeModel(callEcho);
        const after = toolCallsIn(await completeSimple(second.getModel(), context));
        assert.equal(before.length, 1);
        assert.deepEqual(after, before);
    });
});

describe("createFakeModel delay", () => {
    const context = { messages: [{ role: "user" as const, content: "slow", timestamp: 0 }] };

    it("starts the answer no sooner than delayMs after the request", async () => {
        const fake = makeModel(describeTranscript, () => 80);
        const startedAt = performance.now();
        await completeSimple(fake.getModel(), context);
        assert.ok(performance.now() - startedAt >= 75, "answer arrived before the delay elapsed");
    });

    it("answers at once when delayMs returns zero", async () => {
        const fake = makeModel(describeTranscript, () => 0);
        const startedAt = performance.now();
        await completeSimple(fake.getModel(), context);
        assert.ok(performance.now() - startedAt < 75);
    });

    it("ends the response at once as aborted when the request is aborted during the delay", async () => {
        const fake = makeModel(describeTranscript, () => 60_000);
        const controller = new AbortController();
        const startedAt = performance.now();
        const pending = completeSimple(fake.getModel(), context, { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        const answer = await pending;
        assert.equal(answer.stopReason, "aborted");
        assert.ok(performance.now() - startedAt < 5_000);
    });

    it("applies delayMs to the transcript of each request", async () => {
        const fake = makeModel(describeTranscript, (transcript) => (transcript[0]?.text === "slow" ? 80 : 0));
        const startedAt = performance.now();
        await completeSimple(fake.getModel(), { messages: [{ role: "user", content: "fast", timestamp: 0 }] });
        assert.ok(performance.now() - startedAt < 75);
    });
});
