import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    abortConversation,
    compactConversation,
    HostBusyError,
    HostConflictError,
    HostNotFoundError,
    resetConversation,
    submissionState,
    submitInput,
    waitForSubmission,
    withdrawInput,
} from "../../src/host/conversation_control.ts";
import { type HarnessHost, type HostEntry, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { createFakeModel, type FakeReply, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const ctx = BACKGROUND_CONTEXT;
const BUSY_DELAY_MS = 300;

type FakeModel = ReturnType<typeof createFakeModel>;
type Fixture = { host: HarnessHost; conversationId: string; modelCalls: () => number };

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

// createFakeModel registers the fake in pi-ai's global registry; the harness needs it inside a Models collection.
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
    const reply = (_transcript: FakeTranscript): FakeReply => {
        modelCalls++;
        return options.reply ?? "ok";
    };
    const fake = createFakeModel(reply, { delayMs: () => options.delayMs ?? 0 });
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: options.compactEveryTurn ? { compaction: { keepRecentTokens: 1 } } : {},
        extensions: [waitExtension],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const conversationId = await host.createConversation({
        agent: { model: `${fake.getModel().provider}/${fake.getModel().id}` },
    });
    return { host, conversationId, modelCalls: () => modelCalls };
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

async function waitForSettled(host: HarnessHost, submissionId: string): Promise<void> {
    const submission = await internalHarness(host).submission(Number(submissionId) as never, ctx);
    assert.ok(submission, "submission exists");
    await submission.wait(ctx);
}

async function waitForEntryKind(host: HarnessHost, conversationId: string, kind: string): Promise<void> {
    const attemptLimit = 200;
    const pauseMs = 25;
    for (let attempt = 0; attempt < attemptLimit; attempt++) {
        if ((await allEntries(host, conversationId)).some((entry) => entry.kind === kind)) return;
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    assert.fail(`no ${kind} entry appeared in conversation ${conversationId}`);
}

const userTexts = (entries: HostEntry[]): string[] =>
    entries.filter((entry) => entry.kind === "pi.user").map((entry) => JSON.stringify(entry.data));

describe("submitInput", () => {
    it("returns the same submission id and runs the model once when one request id is submitted twice", async () => {
        const { host, conversationId, modelCalls } = await openFixture();
        const input = { content: "hello", requestId: "req-1", busyMode: "followUp" } as const;

        const first = await submitInput(host, conversationId, input);
        const second = await submitInput(host, conversationId, input);
        await waitForSettled(host, first.submissionId);

        assert.equal(second.submissionId, first.submissionId);
        assert.equal(modelCalls(), 1);
    });

    it("throws HostBusyError and queues nothing when busy mode reject reaches a busy conversation", async () => {
        const { host, conversationId } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const running = await submitInput(host, conversationId, {
            content: "first",
            requestId: "req-1",
            busyMode: "followUp",
        });

        await assert.rejects(
            submitInput(host, conversationId, { content: "second", requestId: "req-2", busyMode: "reject" }),
            HostBusyError,
        );
        await waitForSettled(host, running.submissionId);

        const texts = userTexts(await allEntries(host, conversationId));
        assert.equal(texts.length, 1);
        assert.ok(!texts.some((text) => text.includes("second")));
    });
});

describe("withdrawInput", () => {
    it("settles a queued submission unanswered and never places it in the transcript", async () => {
        const { host, conversationId } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const running = await submitInput(host, conversationId, {
            content: "first",
            requestId: "req-1",
            busyMode: "followUp",
        });
        const queued = await submitInput(host, conversationId, {
            content: "second",
            requestId: "req-2",
            busyMode: "followUp",
        });
        assert.equal((await submissionState(host, queued.submissionId)).state, "queued");

        await withdrawInput(host, queued.submissionId);
        await waitForSettled(host, running.submissionId);

        assert.equal((await submissionState(host, queued.submissionId)).state, "unanswered");
        assert.ok((await submissionState(host, queued.submissionId)).reason);
        const texts = userTexts(await allEntries(host, conversationId));
        assert.equal(texts.length, 1);
        assert.ok(!texts.some((text) => text.includes("second")));
    });

    it("throws HostConflictError when the input is already placed", async () => {
        const { host, conversationId } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const running = await submitInput(host, conversationId, {
            content: "first",
            requestId: "req-1",
            busyMode: "followUp",
        });

        await assert.rejects(withdrawInput(host, running.submissionId), HostConflictError);
        await waitForSettled(host, running.submissionId);
    });

    it("throws HostNotFoundError for an unknown submission", async () => {
        const { host } = await openFixture();

        await assert.rejects(withdrawInput(host, "9999"), HostNotFoundError);
    });
});

describe("submissionState", () => {
    it("reports running while the model answers and done afterwards", async () => {
        const { host, conversationId } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const { submissionId } = await submitInput(host, conversationId, {
            content: "hello",
            requestId: "req-1",
            busyMode: "followUp",
        });

        assert.deepEqual(await submissionState(host, submissionId), { state: "running" });
        await waitForSettled(host, submissionId);
        assert.deepEqual(await submissionState(host, submissionId), { state: "done" });
    });
});

describe("waitForSubmission", () => {
    const SHORT_TIMEOUT_MS = 20;
    const LONG_TIMEOUT_MS = 10_000;

    it("returns the current state without throwing when the timeout comes before the submission settles", async () => {
        const { host, conversationId } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const { submissionId } = await submitInput(host, conversationId, {
            content: "hello",
            requestId: "req-1",
            busyMode: "followUp",
        });

        const state = await waitForSubmission(host, submissionId, SHORT_TIMEOUT_MS);

        assert.deepEqual(state, { state: "running" });
    });

    it("returns done once the submission settles before the timeout", async () => {
        const { host, conversationId } = await openFixture();
        const { submissionId } = await submitInput(host, conversationId, {
            content: "hello",
            requestId: "req-1",
            busyMode: "followUp",
        });

        assert.deepEqual(await waitForSubmission(host, submissionId, LONG_TIMEOUT_MS), { state: "done" });
    });
});

describe("conversation control", () => {
    it("leaves an aborted conversation idle with the aborted tool call in its entries", async () => {
        const { host, conversationId } = await openFixture({ reply: { toolCall: { name: "wait", arguments: {} } } });
        const { submissionId } = await submitInput(host, conversationId, {
            content: "hello",
            requestId: "req-1",
            busyMode: "followUp",
        });
        await waitForEntryKind(host, conversationId, "pi.assistant");

        await abortConversation(host, conversationId);

        assert.equal((await host.conversationInfo(conversationId))?.busy, false);
        assert.deepEqual(await submissionState(host, submissionId), { state: "unanswered", reason: "aborted" });
        const entries = await allEntries(host, conversationId);
        const abortedResult = entries.find((entry) => entry.kind === "pi.tool-result");
        assert.match(JSON.stringify(abortedResult?.data), /Tool wait was aborted/);
    });

    it("leaves a reset conversation idle with a pi.reset entry", async () => {
        const { host, conversationId } = await openFixture();
        const { submissionId } = await submitInput(host, conversationId, {
            content: "hello",
            requestId: "req-1",
            busyMode: "followUp",
        });
        await waitForSettled(host, submissionId);

        await resetConversation(host, conversationId, "carry on");

        assert.equal((await host.conversationInfo(conversationId))?.busy, false);
        assert.ok((await allEntries(host, conversationId)).some((entry) => entry.kind === "pi.reset"));
    });

    it("leaves a compacted conversation idle with a pi.compaction entry", async () => {
        const { host, conversationId } = await openFixture({ compactEveryTurn: true });
        for (const requestId of ["req-1", "req-2"]) {
            const { submissionId } = await submitInput(host, conversationId, {
                content: "hello",
                requestId,
                busyMode: "followUp",
            });
            await waitForSettled(host, submissionId);
        }

        await compactConversation(host, conversationId, "be brief");

        assert.equal((await host.conversationInfo(conversationId))?.busy, false);
        assert.ok((await allEntries(host, conversationId)).some((entry) => entry.kind === "pi.compaction"));
    });
});
