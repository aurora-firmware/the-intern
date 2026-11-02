import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type Admission, createAdmission } from "../../src/admission/admission.ts";
import { createAdmissionGate } from "../../src/admission/admission_extension.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { abortConversation, submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_ATTEMPTS = 200;
const POLL_PAUSE_MS = 25;
const REPLY_DELAY_MS = 150;
const LONG_REPLY_DELAY_MS = 20_000;
const SETTLE_TIMEOUT_MS = 20_000;

type FakeModel = ReturnType<typeof createFakeModel>;

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: FakeModel[] = [];
const admissions: Admission[] = [];

afterEach(async () => {
    for (const admission of admissions.splice(0)) admission.stop();
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

type Fixture = {
    host: HarnessHost;
    admission: Admission;
    modelId: string;
    /** The user texts of the model requests, in the order the requests were made. */
    requests: string[];
    /** The most model requests that were in flight at once. */
    maxInFlight(): number;
    newConversation(): Promise<string>;
    submit(conversationId: string, content: string): Promise<string>;
};

type OpenOptions = { env: HermeticEnv; capacity: number; delayMs?: number };

function lastUserText(transcript: readonly { role: string; text: string }[]): string {
    return transcript.filter((message) => message.role === "user").at(-1)?.text ?? "";
}

async function openFixture(options: OpenOptions): Promise<Fixture> {
    const requests: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = createFakeModel(
        (transcript) => {
            inFlight--;
            return `answer to ${lastUserText(transcript)}`;
        },
        {
            delayMs: (transcript) => {
                requests.push(lastUserText(transcript));
                maxInFlight = Math.max(maxInFlight, ++inFlight);
                return options.delayMs ?? REPLY_DELAY_MS;
            },
        },
    );
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const gate = createAdmissionGate();
    const host = await openHarnessHost({
        databaseFile: join(options.env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [gate.extension],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const admission = createAdmission({ host, capacity: options.capacity, logger, gate });
    admissions.push(admission);
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    let requestCount = 0;
    return {
        host,
        admission,
        modelId,
        requests,
        maxInFlight: () => maxInFlight,
        newConversation: () => host.createConversation({ agent: { model: modelId } }),
        async submit(conversationId, content) {
            const { submissionId } = await submitInput(host, conversationId, {
                content,
                requestId: `request-${++requestCount}-${content}`,
                busyMode: "followUp",
            });
            return submissionId;
        },
    };
}

async function newEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

async function pollUntil(isDone: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (isDone()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
    }
    assert.fail("the expected condition never held");
}

async function settle(host: HarnessHost, submissionId: string): Promise<void> {
    const state = await waitForSubmission(host, submissionId, SETTLE_TIMEOUT_MS);
    assert.equal(state.state, "done");
}

describe("admission with one worker thread", () => {
    it("runs three submissions to three conversations one after another in arrival order", async () => {
        const fixture = await openFixture({ env: await newEnv(), capacity: 1 });
        await fixture.admission.restore();
        fixture.host.resume();
        const conversations = [await fixture.newConversation(), await fixture.newConversation()];
        conversations.push(await fixture.newConversation());

        const submissions: string[] = [];
        for (const [index, conversationId] of conversations.entries()) {
            submissions.push(await fixture.submit(conversationId, `message-${index}`));
        }
        for (const submissionId of submissions) await settle(fixture.host, submissionId);

        assert.deepEqual(fixture.requests, ["message-0", "message-1", "message-2"]);
        assert.equal(fixture.maxInFlight(), 1);
    });

    it("makes no model request for a waiting conversation and reports its queue position", async () => {
        const fixture = await openFixture({ env: await newEnv(), capacity: 1, delayMs: LONG_REPLY_DELAY_MS });
        await fixture.admission.restore();
        fixture.host.resume();
        const [first, second, third] = [
            await fixture.newConversation(),
            await fixture.newConversation(),
            await fixture.newConversation(),
        ];
        await fixture.submit(first, "message-0");
        await fixture.submit(second, "message-1");
        await fixture.submit(third, "message-2");

        await pollUntil(() => fixture.admission.state().waiting.length === 2);

        assert.deepEqual(fixture.admission.state(), {
            capacity: 1,
            active: [first],
            waiting: [
                { conversationId: second, position: 1 },
                { conversationId: third, position: 2 },
            ],
        });
        assert.deepEqual(fixture.requests, ["message-0"]);
    });

    it("grants the head of the waiting list when the running conversation is aborted", async () => {
        const fixture = await openFixture({ env: await newEnv(), capacity: 1, delayMs: LONG_REPLY_DELAY_MS });
        await fixture.admission.restore();
        fixture.host.resume();
        const [first, second, third] = [
            await fixture.newConversation(),
            await fixture.newConversation(),
            await fixture.newConversation(),
        ];
        await fixture.submit(first, "message-0");
        await fixture.submit(second, "message-1");
        await fixture.submit(third, "message-2");
        await pollUntil(() => fixture.admission.state().waiting.length === 2);

        await abortConversation(fixture.host, first);
        await pollUntil(() => fixture.requests.includes("message-1"));

        assert.deepEqual(fixture.admission.state().active, [second]);
        assert.deepEqual(fixture.admission.state().waiting, [{ conversationId: third, position: 1 }]);
        assert.deepEqual(fixture.requests, ["message-0", "message-1"]);
    });

    it("drops an aborted waiting conversation from the list without a model request", async () => {
        const fixture = await openFixture({ env: await newEnv(), capacity: 1, delayMs: LONG_REPLY_DELAY_MS });
        await fixture.admission.restore();
        fixture.host.resume();
        const [first, second, third] = [
            await fixture.newConversation(),
            await fixture.newConversation(),
            await fixture.newConversation(),
        ];
        await fixture.submit(first, "message-0");
        await fixture.submit(second, "message-1");
        await fixture.submit(third, "message-2");
        await pollUntil(() => fixture.admission.state().waiting.length === 2);

        await abortConversation(fixture.host, second);
        await pollUntil(() => fixture.admission.state().waiting.length === 1);

        assert.deepEqual(fixture.admission.state().waiting, [{ conversationId: third, position: 1 }]);
        assert.deepEqual(fixture.requests, ["message-0"]);
    });

    it("awaits a granted listener, with the conversation's id, before the model request is made", async () => {
        const fixture = await openFixture({ env: await newEnv(), capacity: 1 });
        await fixture.admission.restore();
        fixture.host.resume();
        const conversation = await fixture.newConversation();
        const granted: string[] = [];
        let finishListener = (): void => {};
        fixture.admission.onGranted(async (conversationId) => {
            granted.push(conversationId);
            await new Promise<void>((resolve) => {
                finishListener = resolve;
            });
        });

        const submission = await fixture.submit(conversation, "message-0");
        await pollUntil(() => granted.length === 1);
        await new Promise((resolve) => setTimeout(resolve, REPLY_DELAY_MS));

        assert.deepEqual(granted, [conversation]);
        assert.deepEqual(fixture.requests, []);
        finishListener();
        await settle(fixture.host, submission);
        assert.deepEqual(fixture.requests, ["message-0"]);
    });

    it("rejects acquire with a granted listener's error, and stops calling a removed listener", async () => {
        const fixture = await openFixture({ env: await newEnv(), capacity: 1 });
        await fixture.admission.restore();
        const conversation = await fixture.newConversation();
        const { signal } = new AbortController();
        let calls = 0;
        const remove = fixture.admission.onGranted(async () => {
            calls++;
            throw new Error("listener failed");
        });

        await assert.rejects(fixture.admission.acquire(conversation, signal), /listener failed/);
        remove();
        await fixture.admission.acquire(conversation, signal);

        assert.equal(calls, 1);
    });
});

async function closeFixture(fixture: Fixture): Promise<void> {
    fixture.admission.stop();
    hosts.splice(hosts.indexOf(fixture.host), 1);
    await fixture.host.close();
}

function neverAborted(): AbortSignal {
    return new AbortController().signal;
}

describe("admission after the host is opened again", () => {
    it("resumes the active run first and starts the waiting runs in their stored order", async () => {
        const env = await newEnv();
        const first = await openFixture({ env, capacity: 1, delayMs: LONG_REPLY_DELAY_MS });
        await first.admission.restore();
        first.host.resume();
        const conversations = [await first.newConversation(), await first.newConversation()];
        conversations.push(await first.newConversation());
        const submissions: string[] = [];
        for (const [index, conversationId] of conversations.entries()) {
            submissions.push(await first.submit(conversationId, `message-${index}`));
        }
        await pollUntil(() => first.admission.state().waiting.length === 2);
        await closeFixture(first);

        const second = await openFixture({ env, capacity: 1 });
        await second.admission.restore();
        second.host.resume();
        for (const submissionId of submissions) await settle(second.host, submissionId);

        assert.deepEqual(second.requests, ["message-0", "message-1", "message-2"]);
        assert.equal(second.maxInFlight(), 1);
    });

    it("drops an idle conversation committed into active and gives its worker thread to the next waiting run", async () => {
        const env = await newEnv();
        const first = await openFixture({ env, capacity: 1, delayMs: LONG_REPLY_DELAY_MS });
        await first.admission.restore();
        first.host.resume();
        const idle = await first.newConversation();
        const waitingConversations = [await first.newConversation(), await first.newConversation()];
        await first.admission.acquire(idle, neverAborted());
        const submissions: string[] = [];
        for (const [index, conversationId] of waitingConversations.entries()) {
            submissions.push(await first.submit(conversationId, `message-${index}`));
        }
        await pollUntil(() => first.admission.state().waiting.length === 2);
        assert.deepEqual(first.admission.state().active, [idle]);
        await closeFixture(first);

        const second = await openFixture({ env, capacity: 1 });
        await second.admission.restore();

        assert.deepEqual(second.admission.state(), {
            capacity: 1,
            active: [waitingConversations[0]],
            waiting: [{ conversationId: waitingConversations[1], position: 1 }],
        });
        second.host.resume();
        for (const submissionId of submissions) await settle(second.host, submissionId);
        assert.deepEqual(second.requests, ["message-0", "message-1"]);
    });

    it("keeps the extra runs waiting at the head of the queue when the capacity is lower", async () => {
        const env = await newEnv();
        const first = await openFixture({ env, capacity: 2, delayMs: LONG_REPLY_DELAY_MS });
        await first.admission.restore();
        first.host.resume();
        const conversations = [await first.newConversation(), await first.newConversation()];
        conversations.push(await first.newConversation());
        const submissions: string[] = [];
        for (const [index, conversationId] of conversations.entries()) {
            submissions.push(await first.submit(conversationId, `message-${index}`));
        }
        await pollUntil(() => first.admission.state().waiting.length === 1);
        assert.deepEqual(first.admission.state().active, [conversations[0], conversations[1]]);
        await closeFixture(first);

        const second = await openFixture({ env, capacity: 1 });
        await second.admission.restore();

        assert.deepEqual(second.admission.state(), {
            capacity: 1,
            active: [conversations[0]],
            waiting: [
                { conversationId: conversations[1], position: 1 },
                { conversationId: conversations[2], position: 2 },
            ],
        });
        second.host.resume();
        for (const submissionId of submissions) await settle(second.host, submissionId);
        assert.deepEqual(second.requests, ["message-0", "message-1", "message-2"]);
        assert.equal(second.maxInFlight(), 1);
    });
});
