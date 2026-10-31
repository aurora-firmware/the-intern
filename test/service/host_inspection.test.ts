import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { abortConversation, HostNotFoundError, submitInput } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { conversationUsage, liveTasks, totalUsage } from "../../src/host/host_inspection.ts";
import { createFakeModel, type FakeReply } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const ctx = BACKGROUND_CONTEXT;
const POLL_ATTEMPTS = 200;
const POLL_PAUSE_MS = 25;

type FakeModel = ReturnType<typeof createFakeModel>;

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

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

type Fixture = { host: HarnessHost; modelId: string; newConversation(): Promise<string> };

async function openFixture(reply: FakeReply = "ok"): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => reply);
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [waitExtension],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    return { host, modelId, newConversation: () => host.createConversation({ agent: { model: modelId } }) };
}

async function answer(host: HarnessHost, conversationId: string, requestId: string): Promise<void> {
    const { submissionId } = await submitInput(host, conversationId, {
        content: "hello",
        requestId,
        busyMode: "followUp",
    });
    const submission = await internalHarness(host).submission(Number(submissionId) as never, ctx);
    assert.ok(submission, "submission exists");
    await submission.wait(ctx);
}

async function pollUntil<T>(read: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        const value = await read();
        if (isDone(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
    }
    return assert.fail("the expected condition never held");
}

describe("conversationUsage and totalUsage", () => {
    it("reports usage per model for an answered conversation", async () => {
        const { host, modelId, newConversation } = await openFixture();
        const id = await newConversation();
        await answer(host, id, "req-1");

        const report = await conversationUsage(host, id);

        assert.deepEqual(Object.keys(report.models), [modelId]);
        assert.deepEqual(report.tools, {});
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
            assert.equal(typeof report.models[modelId]?.[field], "number", field);
        }
        assert.equal(typeof report.models[modelId]?.cost.total, "number");
    });

    it("sums the usage of every conversation in the total", async () => {
        const { host, modelId, newConversation } = await openFixture();
        const first = await newConversation();
        const second = await newConversation();
        await answer(host, first, "req-1");
        await answer(host, second, "req-2");

        const [firstReport, secondReport, total] = await Promise.all([
            conversationUsage(host, first),
            conversationUsage(host, second),
            totalUsage(host),
        ]);

        const parts = [firstReport, secondReport].map((report) => report.models[modelId]);
        assert.ok(parts.every((part) => part !== undefined));
        assert.equal(total.models[modelId]?.input, (parts[0]?.input ?? 0) + (parts[1]?.input ?? 0));
        assert.equal(total.models[modelId]?.totalTokens, (parts[0]?.totalTokens ?? 0) + (parts[1]?.totalTokens ?? 0));
        assert.ok((total.models[modelId]?.totalTokens ?? 0) > 0, "the fake model reports tokens");
    });

    it("returns empty buckets for a conversation that was never answered", async () => {
        const { host, newConversation } = await openFixture();
        const id = await newConversation();

        assert.deepEqual(await conversationUsage(host, id), { models: {}, tools: {} });
    });
});

describe("liveTasks", () => {
    it("lists the generation task and the tool task with their states while a tool call runs", async () => {
        const { host, newConversation } = await openFixture({ toolCall: { name: "wait", arguments: {} } });
        const id = await newConversation();
        await submitInput(host, id, { content: "go", requestId: "req-1", busyMode: "followUp" });

        const tasks = await pollUntil(
            () => liveTasks(host, id),
            (list) => list.some((task) => task.kind === "pi.tool"),
        );

        const generation = tasks.find((task) => task.kind === "pi.generation");
        const tool = tasks.find((task) => task.kind === "pi.tool");
        assert.ok(generation, `a generation task is listed: ${JSON.stringify(tasks)}`);
        assert.ok(tool);
        assert.ok(generation.taskId.length > 0 && generation.state.length > 0);
        assert.ok(tool.taskId.length > 0 && tool.state.length > 0);
        assert.equal(tool.blockedReason, undefined);
        await abortConversation(host, id);
    });

    it("returns no task while the conversation is idle", async () => {
        const { host, newConversation } = await openFixture();
        const id = await newConversation();
        await answer(host, id, "req-1");

        assert.deepEqual(await liveTasks(host, id), []);
    });
});

// A task of an extension: once the extension is not installed, nothing can run the task and the graph blocks it.
const parkedTask = defineTask<null, { phase: "idle" }, null>({
    name: "test.parked",
    version: 1,
    initial: () => ({ phase: "idle" }),
    phases: { idle: async () => undefined },
    abort: (_task, runtime, taskContext) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});
const parkedExtension = defineExtension({ name: "parked", tasks: [parkedTask] });

describe("liveTasks of a task that cannot run", () => {
    it("names the missing definition as the blocked reason after a restart without the task's extension", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const fake = createFakeModel(() => "ok");
        fakes.push(fake);
        const open = (extensions: Parameters<typeof openHarnessHost>[0]["extensions"]) =>
            openHarnessHost({
                databaseFile: join(env.root, "state.sqlite"),
                models: modelsFor(fake),
                harnessSettings: {},
                extensions,
                defaultCwd: process.cwd(),
                logger: createLogger({ stream: { write: () => true } }),
            });
        const first = await open([parkedExtension]);
        const id = await first.createConversation({
            agent: { model: `${fake.getModel().provider}/${fake.getModel().id}` },
        });
        const conversation = await internalHarness(first).conversation(Number(id) as never, ctx);
        assert.ok(conversation, "conversation exists");
        await conversation.commit(
            (tx) =>
                tx.createTask(parkedTask, null, {
                    ownership: { kind: "conversation" },
                }),
            ctx,
        );
        assert.equal((await liveTasks(first, id))[0]?.blockedReason, undefined);
        await first.close();

        const second = await open([]);
        hosts.push(second);
        const tasks = await liveTasks(second, id);

        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.kind, "test.parked");
        assert.equal(tasks[0]?.blockedReason, "missing_task");
    });
});

describe("unknown conversation ids", () => {
    it("throws HostNotFoundError from conversationUsage and liveTasks", async () => {
        const { host } = await openFixture();

        await assert.rejects(conversationUsage(host, "999"), HostNotFoundError);
        await assert.rejects(liveTasks(host, "999"), HostNotFoundError);
        await assert.rejects(conversationUsage(host, "not-a-number"), HostNotFoundError);
    });
});
