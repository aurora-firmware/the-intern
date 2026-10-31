import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, type HostEntry, openHarnessHost } from "../../src/host/harness_host.ts";
import { conversationControlOperations } from "../../src/service/conversation_control_operations.ts";
import { type Caller, createCatalogue, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel, type FakeReply } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SETTLE_TIMEOUT_MS = 20_000;
const BUSY_DELAY_MS = 400;
const POLL_ATTEMPTS = 200;
const POLL_PAUSE_MS = 25;
const UNKNOWN_ID = "9999";
const caller: Caller = { actor: { kind: "team_member" } };

type FakeModel = ReturnType<typeof createFakeModel>;
type Fixture = {
    host: HarnessHost;
    conversationId: string;
    modelCalls(): number;
    call(name: string, input?: unknown): Promise<unknown>;
    submit(content: string, requestId: string, busyMode?: string): Promise<{ submissionId: string }>;
    settle(submissionId: string): Promise<void>;
    stateOf(submissionId: string): Promise<{ state: string; reason?: string }>;
};

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: FakeModel[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function modelsFor(fake: FakeModel): Models {
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation, "the fake model's api is registered");
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return models;
}

// Holds a tool call open until the abort reaches it, so the run is cut off mid-round.
const waitTool = defineTool({
    name: "wait",
    description: "Waits until aborted",
    parameters: Type.Object({}),
    execute: async (_args, _api, toolContext) => {
        await new Promise<void>((resolve) => {
            if (toolContext.abortSignal?.aborted) resolve();
            toolContext.abortSignal?.addEventListener("abort", () => resolve());
        });
        return { output: [{ type: "text", text: "stopped" }] };
    },
});
const waitExtension = defineExtension({ name: "wait", tools: [waitTool] });

type FixtureOptions = { delayMs?: number; reply?: FakeReply; compactEveryTurn?: boolean };

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    let modelCalls = 0;
    const fake = createFakeModel(
        () => {
            modelCalls++;
            return options.reply ?? "ok";
        },
        { delayMs: () => options.delayMs ?? 0 },
    );
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: options.compactEveryTurn ? { compaction: { keepRecentTokens: 1 } } : {},
        extensions: [waitExtension],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const conversationId = await host.createConversation({
        agent: { model: `${fake.getModel().provider}/${fake.getModel().id}` },
    });
    const catalogue = createCatalogue(conversationControlOperations, {
        context: { host },
        phase: () => "ready",
        logger,
    });
    const call = (name: string, input?: unknown) => catalogue.invoke(name, input ?? {}, caller);
    return {
        host,
        conversationId,
        modelCalls: () => modelCalls,
        call,
        submit: (content, requestId, busyMode) =>
            call("conversations.submit", {
                conversationId,
                content,
                requestId,
                ...(busyMode !== undefined && { busyMode }),
            }) as Promise<{ submissionId: string }>,
        async settle(submissionId) {
            assert.equal((await waitForSubmission(host, submissionId, SETTLE_TIMEOUT_MS)).state, "done");
        },
        async stateOf(submissionId) {
            return waitForSubmission(host, submissionId, 0);
        },
    };
}

async function allEntries(host: HarnessHost, id: string): Promise<HostEntry[]> {
    const entries: HostEntry[] = [];
    let after: string | undefined;
    do {
        const page = await host.readEntries(id, after === undefined ? { limit: 100 } : { after, limit: 100 });
        entries.push(...page.entries);
        after = page.next;
    } while (after !== undefined);
    return entries;
}

async function waitForEntryKind(host: HarnessHost, conversationId: string, kind: string): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if ((await allEntries(host, conversationId)).some((entry) => entry.kind === kind)) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
    }
    assert.fail(`no ${kind} entry appeared in conversation ${conversationId}`);
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
        return error.code;
    }
    return assert.fail("expected the call to reject");
}

const userTexts = (entries: HostEntry[]): string[] =>
    entries.filter((entry) => entry.kind === "pi.user").map((entry) => JSON.stringify(entry.data));

async function isBusy(fixture: Fixture): Promise<boolean | undefined> {
    return (await fixture.host.conversationInfo(fixture.conversationId))?.busy;
}

describe("the conversation control operations", () => {
    it("are all of kind control", () => {
        assert.deepEqual(conversationControlOperations.map(({ name, kind }) => [name, kind]).sort(), [
            ["conversations.abort", "control"],
            ["conversations.compact", "control"],
            ["conversations.reset", "control"],
            ["conversations.submit", "control"],
            ["submissions.withdraw", "control"],
        ]);
    });
});

describe("conversations.submit", () => {
    it("returns the same submission id and admits the input once when one request id is submitted twice", async () => {
        const fixture = await openFixture();

        const first = await fixture.submit("hello", "req-1");
        const second = await fixture.submit("hello", "req-1");
        await fixture.settle(first.submissionId);

        assert.equal(second.submissionId, first.submissionId);
        assert.equal(fixture.modelCalls(), 1);
        assert.equal(userTexts(await allEntries(fixture.host, fixture.conversationId)).length, 1);
    });

    it("rejects with busy and queues nothing when busy mode reject reaches a busy conversation", async () => {
        const fixture = await openFixture({ delayMs: BUSY_DELAY_MS });
        const running = await fixture.submit("first", "req-1");

        assert.equal(await rejectionCode(fixture.submit("second", "req-2", "reject")), "busy");
        await fixture.settle(running.submissionId);

        const texts = userTexts(await allEntries(fixture.host, fixture.conversationId));
        assert.equal(texts.length, 1);
        assert.ok(!texts.some((text) => text.includes("second")));
    });

    it("rejects with invalid_input and changes nothing when the request id is missing", async () => {
        const fixture = await openFixture();

        const code = await rejectionCode(
            fixture.call("conversations.submit", { conversationId: fixture.conversationId, content: "hello" }),
        );

        assert.equal(code, "invalid_input");
        assert.equal(fixture.modelCalls(), 0);
        assert.equal((await allEntries(fixture.host, fixture.conversationId)).length, 0);
    });

    it("rejects with invalid_input when the busy mode is not followUp, steer or reject", async () => {
        const fixture = await openFixture();

        assert.equal(await rejectionCode(fixture.submit("hello", "req-1", "later")), "invalid_input");
    });

    it("rejects with not_found for an unknown conversation", async () => {
        const fixture = await openFixture();

        const code = await rejectionCode(
            fixture.call("conversations.submit", { conversationId: UNKNOWN_ID, content: "hi", requestId: "req-1" }),
        );

        assert.equal(code, "not_found");
    });
});

describe("submissions.withdraw", () => {
    it("settles a queued input unanswered", async () => {
        const fixture = await openFixture({ delayMs: BUSY_DELAY_MS });
        const running = await fixture.submit("first", "req-1");
        const queued = await fixture.submit("second", "req-2");

        await fixture.call("submissions.withdraw", { submissionId: queued.submissionId });
        await fixture.settle(running.submissionId);

        assert.equal((await fixture.stateOf(queued.submissionId)).state, "unanswered");
        assert.ok(!userTexts(await allEntries(fixture.host, fixture.conversationId)).some((t) => t.includes("second")));
    });

    it("rejects with conflict when the input is already placed", async () => {
        const fixture = await openFixture({ delayMs: BUSY_DELAY_MS });
        const running = await fixture.submit("first", "req-1");

        const code = await rejectionCode(fixture.call("submissions.withdraw", { submissionId: running.submissionId }));
        await fixture.settle(running.submissionId);

        assert.equal(code, "conflict");
    });

    it("rejects with not_found for an unknown submission", async () => {
        const fixture = await openFixture();

        assert.equal(
            await rejectionCode(fixture.call("submissions.withdraw", { submissionId: UNKNOWN_ID })),
            "not_found",
        );
    });

    it("rejects with invalid_input when the submission id is missing", async () => {
        const fixture = await openFixture();

        assert.equal(await rejectionCode(fixture.call("submissions.withdraw", {})), "invalid_input");
    });
});

describe("conversations.abort, conversations.reset and conversations.compact", () => {
    it("leave an aborted conversation idle with the aborted tool call stored", async () => {
        const fixture = await openFixture({ reply: { toolCall: { name: "wait", arguments: {} } } });
        const { submissionId } = await fixture.submit("hello", "req-1");
        await waitForEntryKind(fixture.host, fixture.conversationId, "pi.assistant");

        await fixture.call("conversations.abort", { conversationId: fixture.conversationId });

        assert.equal(await isBusy(fixture), false);
        assert.deepEqual(await fixture.stateOf(submissionId), { state: "unanswered", reason: "aborted" });
        const result = (await allEntries(fixture.host, fixture.conversationId)).find(
            (e) => e.kind === "pi.tool-result",
        );
        assert.match(JSON.stringify(result?.data), /Tool wait was aborted/);
    });

    it("leave a reset conversation idle with a pi.reset entry", async () => {
        const fixture = await openFixture();
        await fixture.settle((await fixture.submit("hello", "req-1")).submissionId);

        await fixture.call("conversations.reset", { conversationId: fixture.conversationId, note: "carry on" });

        assert.equal(await isBusy(fixture), false);
        assert.ok((await allEntries(fixture.host, fixture.conversationId)).some((e) => e.kind === "pi.reset"));
    });

    it("leave a compacted conversation idle with a pi.compaction entry", async () => {
        const fixture = await openFixture({ compactEveryTurn: true });
        await fixture.settle((await fixture.submit("hello", "req-1")).submissionId);
        await fixture.settle((await fixture.submit("hello", "req-2")).submissionId);

        await fixture.call("conversations.compact", {
            conversationId: fixture.conversationId,
            instructions: "be brief",
        });

        assert.equal(await isBusy(fixture), false);
        assert.ok((await allEntries(fixture.host, fixture.conversationId)).some((e) => e.kind === "pi.compaction"));
    });

    it("reject with not_found for an unknown conversation", async () => {
        const fixture = await openFixture();

        for (const name of ["conversations.abort", "conversations.reset", "conversations.compact"]) {
            assert.equal(await rejectionCode(fixture.call(name, { conversationId: UNKNOWN_ID })), "not_found", name);
        }
    });

    it("reject with invalid_input when the conversation id is missing", async () => {
        const fixture = await openFixture();

        for (const name of ["conversations.abort", "conversations.reset", "conversations.compact"]) {
            assert.equal(await rejectionCode(fixture.call(name, {})), "invalid_input", name);
        }
    });
});
