import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineDoc, defineExtension, defineTool, type JsonObject } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { abortConversation, submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import type { InternModels } from "../../src/models/model_runtime.ts";
import { type Caller, createCatalogue, ServiceError } from "../../src/service/operations.ts";
import { runtimeReadOperations } from "../../src/service/runtime_read_operations.ts";
import { createFakeModel, type FakeReply } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SETTLE_TIMEOUT_MS = 20_000;
const SLOW_REPLY_MS = 1_500;
const SHORT_WAIT_MS = 50;
const POLL_ATTEMPTS = 200;
const POLL_PAUSE_MS = 25;
const caller: Caller = { actor: { kind: "team_member" } };

const listedModels = [
    { model: "fake/one", thinkingLevels: ["off"] },
    { model: "fake/two", thinkingLevels: ["off", "low", "high"] },
];

// The daemon documents (S-002 Definitions, "Database"), declared again here to read what the product stored.
const daemonDocuments = ["intern.admission", "intern.versions", "intern.idempotency"].map((kind) =>
    defineDoc<JsonObject>({
        kind,
        version: 1,
        scope: "session",
        initial: () => ({}),
        checkpointWhen: () => false,
    }),
);

// Holds a tool call open until the abort reaches it, so the tool task stays live.
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

type FakeModel = ReturnType<typeof createFakeModel>;
type Fixture = {
    host: HarnessHost;
    call(name: string, input?: unknown): Promise<unknown>;
    newConversation(): Promise<string>;
    send(conversationId: string, content: string): Promise<string>;
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

type FixtureOptions = { reply?: FakeReply; delayMs?: number };

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => options.reply ?? "ok", { delayMs: () => options.delayMs ?? 0 });
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [waitExtension],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    host.resume();
    const models = { listModels: () => listedModels } as unknown as InternModels;
    const catalogue = createCatalogue(runtimeReadOperations, {
        context: { host, models },
        phase: () => "ready",
        logger,
    });
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    let requestCount = 0;
    return {
        host,
        call: (name, input) => catalogue.invoke(name, input ?? {}, caller),
        newConversation: () => host.createConversation({ agent: { model: modelId } }),
        async send(conversationId, content) {
            const { submissionId } = await submitInput(host, conversationId, {
                content,
                requestId: `request-${++requestCount}`,
                busyMode: "followUp",
            });
            return submissionId;
        },
    };
}

async function pollUntil<T>(read: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        const value = await read();
        if (isDone(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
    }
    return assert.fail("the expected condition never held");
}

async function rejection(promise: Promise<unknown>): Promise<ServiceError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
        return error;
    }
    return assert.fail("expected the call to reject");
}

type UsageResult = { models: Record<string, { totalTokens: number }>; tools: Record<string, unknown> };

describe("submissions.get", () => {
    it("returns the state of a settled submission", async () => {
        const fixture = await openFixture();
        const submissionId = await fixture.send(await fixture.newConversation(), "hello");
        await waitForSubmission(fixture.host, submissionId, SETTLE_TIMEOUT_MS);

        assert.deepEqual(await fixture.call("submissions.get", { submissionId }), { state: "done" });
    });

    it("rejects an unknown submission with not_found", async () => {
        const fixture = await openFixture();
        assert.equal((await rejection(fixture.call("submissions.get", { submissionId: "999" }))).code, "not_found");
    });

    it("rejects a missing submission id with invalid_input", async () => {
        const fixture = await openFixture();
        assert.equal((await rejection(fixture.call("submissions.get", {}))).code, "invalid_input");
    });
});

describe("submissions.wait", () => {
    it("returns the settled state once the submission settles", async () => {
        const fixture = await openFixture();
        const submissionId = await fixture.send(await fixture.newConversation(), "hello");

        const state = await fixture.call("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });

        assert.deepEqual(state, { state: "done" });
    });

    it("returns the current state when the timeout passes first", async () => {
        const fixture = await openFixture({ delayMs: SLOW_REPLY_MS });
        const submissionId = await fixture.send(await fixture.newConversation(), "hello");

        const state = (await fixture.call("submissions.wait", { submissionId, timeoutMs: SHORT_WAIT_MS })) as {
            state: string;
        };

        assert.notEqual(state.state, "done");
        await waitForSubmission(fixture.host, submissionId, SETTLE_TIMEOUT_MS);
    });

    it("accepts the limits 0 and 300000", async () => {
        const fixture = await openFixture();
        const submissionId = await fixture.send(await fixture.newConversation(), "hello");
        await waitForSubmission(fixture.host, submissionId, SETTLE_TIMEOUT_MS);

        for (const timeoutMs of [0, 300_000]) {
            assert.deepEqual(await fixture.call("submissions.wait", { submissionId, timeoutMs }), { state: "done" });
        }
    });

    it("rejects a timeout below 0 or above 300000 with invalid_input naming the limit", async () => {
        const fixture = await openFixture();
        for (const timeoutMs of [-1, 300_001, 1.5, "10", undefined]) {
            const error = await rejection(fixture.call("submissions.wait", { submissionId: "1", timeoutMs }));
            assert.equal(error.code, "invalid_input", `timeoutMs ${String(timeoutMs)}`);
            assert.ok(error.message.includes("300000"), error.message);
        }
    });

    it("rejects an unknown submission with not_found", async () => {
        const fixture = await openFixture();
        const error = await rejection(fixture.call("submissions.wait", { submissionId: "999", timeoutMs: 0 }));
        assert.equal(error.code, "not_found");
    });
});

describe("usage.get", () => {
    it("returns one conversation's usage and, without an id, the instance total", async () => {
        const fixture = await openFixture();
        const first = await fixture.newConversation();
        const second = await fixture.newConversation();
        for (const id of [first, second]) {
            await waitForSubmission(fixture.host, await fixture.send(id, "hello"), SETTLE_TIMEOUT_MS);
        }

        const firstUsage = (await fixture.call("usage.get", { conversationId: first })) as UsageResult;
        const secondUsage = (await fixture.call("usage.get", { conversationId: second })) as UsageResult;
        const total = (await fixture.call("usage.get")) as UsageResult;

        const tokens = (usage: UsageResult) => Object.values(usage.models)[0]?.totalTokens ?? 0;
        assert.ok(tokens(firstUsage) > 0, "the fake model reports tokens");
        assert.equal(tokens(total), tokens(firstUsage) + tokens(secondUsage));
    });

    it("rejects an unknown conversation with not_found", async () => {
        const fixture = await openFixture();
        assert.equal((await rejection(fixture.call("usage.get", { conversationId: "999" }))).code, "not_found");
    });

    it("rejects a conversation id that is not a string with invalid_input", async () => {
        const fixture = await openFixture();
        assert.equal((await rejection(fixture.call("usage.get", { conversationId: 5 }))).code, "invalid_input");
    });
});

describe("tasks.live", () => {
    it("lists the tool task while a tool call runs and none once the conversation is idle", async () => {
        const fixture = await openFixture({ reply: { toolCall: { name: "wait", arguments: {} } } });
        const id = await fixture.newConversation();
        const submissionId = await fixture.send(id, "go");
        const read = () => fixture.call("tasks.live", { conversationId: id }) as Promise<{ kind: string }[]>;

        const tasks = await pollUntil(read, (list) => list.some((task) => task.kind === "pi.tool"));
        assert.ok(tasks.some((task) => task.kind === "pi.generation"));

        await abortConversation(fixture.host, id);
        await waitForSubmission(fixture.host, submissionId, SETTLE_TIMEOUT_MS);
        assert.deepEqual(await pollUntil(read, (list) => list.length === 0), []);
    });

    it("rejects an unknown conversation with not_found", async () => {
        const fixture = await openFixture();
        assert.equal((await rejection(fixture.call("tasks.live", { conversationId: "999" }))).code, "not_found");
    });
});

describe("models.list", () => {
    it("returns every available model with its thinking levels", async () => {
        const fixture = await openFixture();
        assert.deepEqual(await fixture.call("models.list"), listedModels);
    });
});

describe("read operations leave state unchanged", () => {
    it("is read kind for all five operations", () => {
        assert.deepEqual(runtimeReadOperations.map((operation) => [operation.name, operation.kind]).sort(), [
            ["models.list", "read"],
            ["submissions.get", "read"],
            ["submissions.wait", "read"],
            ["tasks.live", "read"],
            ["usage.get", "read"],
        ]);
    });

    it("changes no conversation's stored entries and no daemon document when every operation runs", async () => {
        const fixture = await openFixture();
        const id = await fixture.newConversation();
        const submissionId = await fixture.send(id, "hello");
        await waitForSubmission(fixture.host, submissionId, SETTLE_TIMEOUT_MS);
        const harness = internalHarness(fixture.host);
        const snapshot = async () => ({
            entries: await fixture.host.readEntries(id, { limit: 500 }),
            documents: await Promise.all(daemonDocuments.map((doc) => harness.snapshot(doc, BACKGROUND_CONTEXT))),
        });
        const before = await snapshot();

        await fixture.call("submissions.get", { submissionId });
        await fixture.call("submissions.wait", { submissionId, timeoutMs: 0 });
        await fixture.call("usage.get", { conversationId: id });
        await fixture.call("usage.get");
        await fixture.call("tasks.live", { conversationId: id });
        await fixture.call("models.list");

        assert.deepEqual(await snapshot(), before);
        assert.ok(before.entries.entries.length > 0);
    });
});
