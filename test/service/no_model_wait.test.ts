/**
 * A conversation whose run ends with `no_model` (ADR-014 decisions 1, 2 and 8; S-001 REQ-027): the run-end queue of
 * `startReportDelivery` records the wait as the `waitingForModel` fact and one `intern.notice` per waiting period, and
 * delivers no report. The tests seat conversations with no model on the fake model and read the transcript, the fact
 * and the model's context.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { requireConversation, submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { toConversationId } from "../../src/host/conversation_id.ts";
import { type HarnessHost, type HostEntry, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { handleNoModelEnd, NOTICE_KIND } from "../../src/host/model_wait.ts";
import { REPORT_KIND, startReportDelivery } from "../../src/host/reports.ts";
import { changeSeat, createSeatedConversation, readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

type FakeModel = ReturnType<typeof createFakeModel>;

const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const ANSWER = "answered";
const context = BACKGROUND_CONTEXT;
const actor: SeatActor = { kind: "daemon" };
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: FakeModel[] = [];
const deliveries: { stop(): void }[] = [];

afterEach(async () => {
    for (const delivery of deliveries.splice(0)) delivery.stop();
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

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function fixture(options: { isDelivering?: boolean } = {}) {
    const { isDelivering = true } = options;
    const env = await createHermeticEnv();
    envs.push(env);
    const requests: string[] = [];
    const fake = createFakeModel(() => ANSWER, {
        onRequest: (transcript) => requests.push(transcript.at(-1)?.text ?? ""),
    });
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
    host.resume();
    if (isDelivering) {
        deliveries.push(await startReportDelivery(host, { logger: createLogger({ stream: { write: () => true } }) }));
    }
    const modelName = `${fake.getModel().provider}/${fake.getModel().id}`;
    const seatWith = (model: string | null): Seat => ({
        role: "developer",
        model,
        workspace: env.root,
        instructions: "Write code.",
        tools: ["read"],
        skills: [],
    });
    let created = 0;
    const seat = async (model: string | null) => {
        created += 1;
        const { conversationId } = await createSeatedConversation(host, {
            scope: "test",
            key: `conversation-${created}`,
            job: { jobId: `job-${created}`, isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
            seat: seatWith(model),
            actor,
        });
        return conversationId;
    };
    const send = async (conversationId: string, content: string): Promise<string> => {
        const { submissionId } = await submitInput(host, conversationId, {
            content,
            requestId: content,
            busyMode: "followUp",
        });
        return submissionId;
    };
    // The run-end queue is serial: once the report of a model-seated invoked conversation is delivered, every run end
    // that was queued before it has been handled.
    const drainRunEnds = async (): Promise<void> => {
        const invokerId = await seat(modelName);
        await createInvokedConversations(host, {
            invokingId: invokerId,
            callId: "drain",
            agents: [{ seat: seatWith(modelName), contextMode: "clean", jobPrompt: "drain" }],
            actor,
        });
        await until(
            async () => (await readConversationMeta(host, invokerId))?.awaiting.length === 0,
            "the drain report",
        );
    };
    return { host, requests, modelName, seat, send, seatWith, drainRunEnds, fake, actor };
}

const entriesOf = async (host: HarnessHost, id: string): Promise<HostEntry[]> =>
    (await host.readEntries(id, { limit: 100 })).entries;
const kindsOf = async (host: HarnessHost, id: string): Promise<string[]> =>
    (await entriesOf(host, id)).map((entry) => entry.kind);
const noticesOf = async (host: HarnessHost, id: string) =>
    (await entriesOf(host, id)).filter((entry) => entry.kind === NOTICE_KIND);

async function waitNoModel(host: HarnessHost, submissionId: string): Promise<void> {
    assert.deepEqual(await waitForSubmission(host, submissionId, WAIT_MS), { state: "unanswered", reason: "no_model" });
}

describe("a run that ends with no_model", () => {
    it("records the waiting fact with the input's submission id and one notice after the input", async () => {
        const { host, seat, send, drainRunEnds, requests } = await fixture();
        const id = await seat(null);

        const submissionId = await send(id, "first");
        await waitNoModel(host, submissionId);
        await until(async () => (await noticesOf(host, id)).length === 1, "the notice");
        await drainRunEnds();

        const meta = await readConversationMeta(host, id);
        assert.deepEqual(meta?.waitingForModel, { order: submissionId });
        assert.deepEqual(
            (await kindsOf(host, id)).filter((kind) => kind === "pi.user" || kind === NOTICE_KIND),
            ["pi.user", NOTICE_KIND],
        );
        const [notice] = await noticesOf(host, id);
        const data = notice?.data as { notice: string; text: string };
        assert.equal(data.notice, "no_default_model");
        assert.equal(typeof data.text, "string");
        assert.equal(requests.includes("first"), false);
        assert.equal((await host.conversationInfo(id))?.busy, false);
    });

    it("writes the first message, one notice and the second message, in that order", async () => {
        const { host, seat, send, drainRunEnds } = await fixture();
        const id = await seat(null);
        const first = await send(id, "first");
        await waitNoModel(host, first);
        await until(async () => (await noticesOf(host, id)).length === 1, "the notice");

        const second = await send(id, "second");
        await waitNoModel(host, second);
        await drainRunEnds();

        const shown = (await entriesOf(host, id)).filter(
            (entry) => entry.kind === "pi.user" || entry.kind === NOTICE_KIND,
        );
        assert.deepEqual(
            shown.map((entry) => entry.kind),
            ["pi.user", NOTICE_KIND, "pi.user"],
        );
        assert.deepEqual((await readConversationMeta(host, id))?.waitingForModel, { order: first });
    });

    it("leaves the notice out of the model's context", async () => {
        const { host, seat, send, drainRunEnds } = await fixture();
        const id = await seat(null);
        await waitNoModel(host, await send(id, "first"));
        await drainRunEnds();

        const { messages } = await (await requireConversation(host, id)).context(context);

        assert.equal((await noticesOf(host, id)).length, 1);
        assert.deepEqual(
            messages.map((message) => message.role),
            ["user"],
        );
    });

    it("sets no fact and writes no notice when the seat names a model the registry does not resolve", async () => {
        const { host, seat, send, drainRunEnds } = await fixture();
        const id = await seat("ghost/unknown");

        await waitNoModel(host, await send(id, "first"));
        await drainRunEnds();

        assert.equal((await readConversationMeta(host, id))?.waitingForModel, undefined);
        assert.equal((await noticesOf(host, id)).length, 0);
    });

    it("starts the continuation at once when the seat has a model by the time the run end is handled", async () => {
        const { host, seat, send, seatWith, modelName, requests } = await fixture({ isDelivering: false });
        const id = await seat(null);
        await waitNoModel(host, await send(id, "first"));
        await changeSeat(host, id, { seat: seatWith(modelName), actor });

        const isHandled = await handleNoModelEnd(host, id);

        assert.equal(isHandled, true);
        await until(async () => (await kindsOf(host, id)).includes("pi.assistant"), "the answer");
        assert.deepEqual(requests, ["first"]);
        assert.equal((await noticesOf(host, id)).length, 0);
        assert.equal((await readConversationMeta(host, id))?.waitingForModel, undefined);
    });

    it("runs a lead whose role has a model with no notice beside a conversation that waits", async () => {
        const { host, seat, send, modelName, drainRunEnds } = await fixture();
        const waiting = await seat(null);
        const running = await seat(modelName);

        await waitNoModel(host, await send(waiting, "first"));
        await send(running, "work");
        await until(async () => (await kindsOf(host, running)).includes("pi.assistant"), "the answer");
        await drainRunEnds();

        assert.equal((await noticesOf(host, running)).length, 0);
        assert.equal((await noticesOf(host, waiting)).length, 1);
        assert.equal((await host.conversationInfo(waiting))?.busy, false);
    });

    it("delivers no report to the invoker, which keeps awaiting the invoked conversation", async () => {
        const { host, seat, send, seatWith, modelName, drainRunEnds, actor: someActor } = await fixture();
        const invokerId = await seat(modelName);
        const [invokedId] = (await createInvokedConversations(host, {
            invokingId: invokerId,
            callId: "call-1",
            agents: [{ seat: seatWith(null), contextMode: "clean", jobPrompt: "invoked work" }],
            actor: someActor,
        })) as [string];
        await until(async () => (await noticesOf(host, invokedId)).length === 1, "the notice");
        // An earlier answer gives a report something to deliver, so a missing guard shows.
        await internalHarness(host).commit(
            (tx) =>
                tx.appendEntry(AssistantEntry, toConversationId(invokedId), {
                    model: [fauxAssistantMessage("an earlier answer")],
                }),
            context,
        );

        await waitNoModel(host, await send(invokedId, "more work"));
        await drainRunEnds();

        assert.deepEqual((await readConversationMeta(host, invokerId))?.awaiting, [invokedId]);
        assert.equal((await kindsOf(host, invokerId)).includes(REPORT_KIND), false);
    });
});
