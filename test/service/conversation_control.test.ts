import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { HostBusyError, submitInput } from "../../src/host/conversation_control.ts";
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

async function openFixture(options: { delayMs?: number } = {}): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    let modelCalls = 0;
    const reply = (_transcript: FakeTranscript): FakeReply => {
        modelCalls++;
        return "ok";
    };
    const fake = createFakeModel(reply, { delayMs: () => options.delayMs ?? 0 });
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [],
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
