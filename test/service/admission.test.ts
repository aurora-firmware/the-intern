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
});
