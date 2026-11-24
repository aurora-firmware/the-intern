/**
 * The run with no input that releases a conversation which waited for a model (ADR-014 decision 4; S-001 REQ-027
 * paragraph 2). The tests give a conversation's pi-durable agent no model, submit an input that pi-durable ends with
 * `no_model`, seat the fake model and start the run with `startRunWithoutInput`. When the file is started with the
 * argument `child`, it is the process the kill test stops with SIGKILL, and it registers no test.
 */

import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { requireConversation, submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, type HostEntry, openHarnessHost } from "../../src/host/harness_host.ts";
import { startRunWithoutInput } from "../../src/host/model_wait.ts";
import { createFakeModel, type FakeModelOptions } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

type FakeModel = ReturnType<typeof createFakeModel>;

const CHILD_ARGUMENT = "child";
const WAIT_MS = scaled(30_000);
const POLL_INTERVAL_MS = 25;
const ANSWER = "answered after the model came";
const INPUT = "hello";
const context = BACKGROUND_CONTEXT;

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

const modelRefOf = (fake: FakeModel) => ({ provider: fake.getModel().provider, modelId: fake.getModel().id });

async function openHost(databaseFile: string, fake: FakeModel): Promise<HarnessHost> {
    return openHarnessHost({
        databaseFile,
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
}

async function entriesOf(host: HarnessHost, conversationId: string): Promise<HostEntry[]> {
    return (await host.readEntries(conversationId, { limit: 100 })).entries;
}

async function waitForAnswerEntry(host: HarnessHost, conversationId: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        if ((await entriesOf(host, conversationId)).some((entry) => entry.kind === "pi.assistant")) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail("Timed out waiting for the answer entry in the transcript");
}

type Waiting = { conversationId: string; submissionId: string };

// The conversation's agent has no model, so its input is placed and its run ends with no_model; scheduling is on.
async function submitWithNoModel(host: HarnessHost, fake: FakeModel): Promise<Waiting> {
    const conversationId = await host.createConversation({
        agent: { model: `${modelRefOf(fake).provider}/${modelRefOf(fake).modelId}` },
    });
    const conversation = await requireConversation(host, conversationId);
    await conversation.configure({ model: null }, context);
    host.resume();
    const { submissionId } = await submitInput(host, conversationId, {
        content: INPUT,
        requestId: "first",
        busyMode: "reject",
    });
    assert.deepEqual(await waitForSubmission(host, submissionId, WAIT_MS), { state: "unanswered", reason: "no_model" });
    return { conversationId, submissionId };
}

async function seatModel(host: HarnessHost, conversationId: string, fake: FakeModel): Promise<void> {
    await (await requireConversation(host, conversationId)).configure({ model: modelRefOf(fake) }, context);
}

async function runChild(databaseFile: string, conversationId: string): Promise<void> {
    const fake = createFakeModel(() => ANSWER, {
        gate: new Promise<void>(() => {}),
        onRequest: () => process.send?.({ requested: true }),
    });
    const host = await openHost(databaseFile, fake);
    await seatModel(host, conversationId, fake);
    host.resume();
    await startRunWithoutInput(host, conversationId);
    await new Promise<void>(() => {});
}

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: FakeModel[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

async function fixture(options: FakeModelOptions = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const requests: string[] = [];
    const fake = createFakeModel(() => ANSWER, {
        ...options,
        onRequest: (transcript) => {
            requests.push(transcript.at(-1)?.text ?? "");
            options.onRequest?.(transcript);
        },
    });
    fakes.push(fake);
    const databaseFile = join(env.root, "state.sqlite");
    const host = await openHost(databaseFile, fake);
    hosts.push(host);
    return { fake, host, requests, databaseFile };
}

async function userEntryCount(host: HarnessHost, conversationId: string): Promise<number> {
    return (await entriesOf(host, conversationId)).filter((entry) => entry.kind === "pi.user").length;
}

async function waitForIdle(host: HarnessHost, conversationId: string): Promise<void> {
    await (await requireConversation(host, conversationId)).waitForIdle(context);
}

function registerTests(): void {
    describe("startRunWithoutInput", () => {
        it("starts one run that makes one model request and answers the input placed by the no_model run", async () => {
            const { host, fake, requests } = await fixture();
            const { conversationId } = await submitWithNoModel(host, fake);
            await seatModel(host, conversationId, fake);

            const isStarted = await startRunWithoutInput(host, conversationId);
            await waitForAnswerEntry(host, conversationId);
            await waitForIdle(host, conversationId);

            assert.equal(isStarted, true);
            assert.deepEqual(requests, [INPUT]);
            const answers = (await entriesOf(host, conversationId)).filter((entry) => entry.kind === "pi.assistant");
            assert.equal(answers.length, 1);
        });

        it("leaves the submission unanswered with reason no_model and adds no input entry", async () => {
            const { host, fake } = await fixture();
            const { conversationId, submissionId } = await submitWithNoModel(host, fake);
            await seatModel(host, conversationId, fake);
            const inputsBefore = await userEntryCount(host, conversationId);

            await startRunWithoutInput(host, conversationId);
            await waitForAnswerEntry(host, conversationId);
            await waitForIdle(host, conversationId);

            assert.equal(await userEntryCount(host, conversationId), inputsBefore);
            assert.deepEqual(await waitForSubmission(host, submissionId, WAIT_MS), {
                state: "unanswered",
                reason: "no_model",
            });
        });

        it("starts no second run and makes no extra model request while a run is active", async () => {
            const release = Promise.withResolvers<void>();
            const firstRequest = Promise.withResolvers<void>();
            const { host, fake, requests } = await fixture({
                gate: release.promise,
                onRequest: () => firstRequest.resolve(),
            });
            const conversationId = await host.createConversation({
                agent: { model: `${modelRefOf(fake).provider}/${modelRefOf(fake).modelId}` },
            });
            host.resume();
            await submitInput(host, conversationId, { content: INPUT, requestId: "first", busyMode: "reject" });
            await firstRequest.promise;

            const isStarted = await startRunWithoutInput(host, conversationId);
            release.resolve();
            await waitForAnswerEntry(host, conversationId);
            await waitForIdle(host, conversationId);

            assert.equal(isStarted, false);
            assert.deepEqual(requests, [INPUT]);
        });

        it("resumes the run after kill -9 and answers the input once", { timeout: scaled(90_000) }, async () => {
            const { host, fake, databaseFile } = await fixture();
            const { conversationId } = await submitWithNoModel(host, fake);
            await host.close();
            hosts.splice(hosts.indexOf(host), 1);
            const child = fork(import.meta.filename, [CHILD_ARGUMENT, databaseFile, conversationId], {
                execArgv: process.execArgv,
            });
            children.push(child);
            const requested = new Promise<void>((resolve, reject) => {
                child.on("message", () => resolve());
                child.once("exit", () => reject(new Error("The child exited before its model request")));
            });
            await requested;
            child.removeAllListeners("exit");
            const exited = new Promise((resolve) => child.once("exit", resolve));
            child.kill("SIGKILL");
            await exited;

            const reopenedRequests: string[] = [];
            const answering = createFakeModel(() => ANSWER, {
                onRequest: (t) => reopenedRequests.push(t.at(-1)?.text ?? ""),
            });
            fakes.push(answering);
            const reopened = await openHost(databaseFile, answering);
            hosts.push(reopened);
            reopened.resume();
            await waitForAnswerEntry(reopened, conversationId);
            await waitForIdle(reopened, conversationId);

            assert.deepEqual(reopenedRequests, [INPUT]);
            const entries = await entriesOf(reopened, conversationId);
            assert.equal(entries.filter((entry) => entry.kind === "pi.assistant").length, 1);
            assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
        });
    });
}

if (process.argv[2] === CHILD_ARGUMENT) {
    const [, , , databaseFile, conversationId] = process.argv;
    await runChild(databaseFile as string, conversationId as string);
} else {
    registerTests();
}
