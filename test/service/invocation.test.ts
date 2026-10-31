import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    type Message,
    type Models,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { INVOCATION_DEPTH_CAP } from "../../src/daemon/constants.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import {
    continueParked,
    createInvokedConversations,
    InvocationDepthError,
    type InvocationRequest,
    parkConversation,
} from "../../src/host/invocation.ts";
import {
    createSeatedConversation,
    type JobLinks,
    readConversationMeta,
    SEAT_RECORD_KIND,
    type SeatActor,
} from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SUMMARY_TEXT = "SUMMARY-OF-THE-EARLIER-WORK";
const EARLIER_INPUT = "the earlier input";
const WAIT_MS = 10_000;
const fakes: FauxProviderRegistration[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function modelsFor(fake: FauxProviderRegistration): Models {
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

const textOf = (message: Message): string =>
    typeof message.content === "string"
        ? message.content
        : message.content.map((block) => ("text" in block ? block.text : "")).join("");

type Fixture = {
    host: HarnessHost;
    requests: Message[][];
    seat: Seat;
    actor: SeatActor;
    startInvoker(job?: Partial<JobLinks>): Promise<string>;
    requestsTo(prompt: string): Message[][];
};

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one" }] });
    fakes.push(fake);
    const requests: Message[][] = [];
    const answer: FauxResponseFactory = async (context) => {
        fake.appendResponses([answer]);
        requests.push([...context.messages]);
        const isSummarization = context.messages.some(
            (message) => message.role === "system" && textOf(message).includes("context summarization assistant"),
        );
        return fauxAssistantMessage(isSummarization ? SUMMARY_TEXT : "done");
    };
    fake.setResponses([answer]);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: { compaction: { keepRecentTokens: 1 } },
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/model-one`,
        workspace: env.root,
        instructions: "Write code.",
        tools: ["read"],
        skills: [],
    };
    const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
    const startInvoker = async (job: Partial<JobLinks> = {}): Promise<string> => {
        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: `k${requests.length}-${Math.random()}`,
            job: { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0, ...job },
            seat,
            actor,
        });
        const { submissionId } = await submitInput(host, conversationId, {
            content: EARLIER_INPUT,
            requestId: "earlier",
            busyMode: "followUp",
        });
        await waitForSubmission(host, submissionId, WAIT_MS);
        return conversationId;
    };
    const requestsTo = (prompt: string) =>
        requests.filter((request) => request.some((message) => message.role === "user" && textOf(message) === prompt));
    return { host, requests, seat, actor, startInvoker, requestsTo };
}

const request = (fixture: Fixture, jobPrompt: string, contextMode: InvocationRequest["contextMode"] = "clean") => ({
    seat: { ...fixture.seat, role: `invoked-${jobPrompt}` },
    contextMode,
    jobPrompt,
});

const contextText = async (host: HarnessHost, conversationId: string): Promise<string> =>
    JSON.stringify(await host.readContext(conversationId));

// A fork inherits the invoker's seat records, so the invoked conversation's own record is the last one.
async function lastSeatRecord(
    host: HarnessHost,
    conversationId: string,
): Promise<{ previous: unknown; next: unknown }> {
    const page = await host.readEntries(conversationId, { limit: 100 });
    const records = page.entries.filter((entry) => entry.kind === SEAT_RECORD_KIND);
    return records.at(-1)?.data as { previous: unknown; next: unknown };
}

describe("createInvokedConversations", () => {
    it("creates one seated conversation of the same job per request and records each in the invoker's awaiting", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker({ depth: 2 });

        const ids = await createInvokedConversations(fixture.host, {
            invokingId,
            callId: "call-1",
            agents: [request(fixture, "alpha"), request(fixture, "beta")],
            actor: fixture.actor,
        });

        assert.equal(ids.length, 2);
        assert.equal(new Set(ids).size, 2);
        const metas = await Promise.all(ids.map((id) => readConversationMeta(fixture.host, id)));
        for (const [index, meta] of metas.entries()) {
            assert.equal(meta?.jobId, "job-1");
            assert.equal(meta?.isLead, false);
            assert.equal(meta?.depth, 3);
            assert.equal(meta?.invokedBy, invokingId);
            assert.deepEqual(meta?.origin, { kind: "invocation", conversationId: invokingId });
            assert.equal(meta?.seat.role, index === 0 ? "invoked-alpha" : "invoked-beta");
            assert.deepEqual(meta?.awaiting, []);
            assert.equal(meta?.parked, null);
            assert.deepEqual(meta?.held, []);
        }
        assert.deepEqual((await readConversationMeta(fixture.host, invokingId))?.awaiting, ids);
    });

    it("gives the invoked conversation its own document even when the invoker is parked and awaiting", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker();

        const [first] = await createInvokedConversations(fixture.host, {
            invokingId,
            callId: "call-1",
            agents: [request(fixture, "alpha", "full")],
            actor: fixture.actor,
            parked: { waitingFor: "reports", continueOn: "all" },
        });
        const [second] = await createInvokedConversations(fixture.host, {
            invokingId: first as string,
            callId: "call-2",
            agents: [request(fixture, "beta", "full")],
            actor: fixture.actor,
        });

        const invoker = await readConversationMeta(fixture.host, invokingId);
        assert.deepEqual(invoker?.parked, { waitingFor: "reports", continueOn: "all" });
        assert.deepEqual(invoker?.awaiting, [first]);
        const forked = await readConversationMeta(fixture.host, second as string);
        assert.equal(forked?.isLead, false);
        assert.equal(forked?.parked, null);
        assert.deepEqual(forked?.awaiting, []);
        assert.equal(forked?.depth, 2);
    });

    it("starts a Full invoked context with a copy of the invoking context followed by the job prompt", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker();

        const [id] = await createInvokedConversations(fixture.host, {
            invokingId,
            callId: "call-1",
            agents: [request(fixture, "job-full", "full")],
            actor: fixture.actor,
        });

        const [seen] = await waitForRequestsTo(fixture, "job-full");
        const users = seen?.filter((message) => message.role === "user").map(textOf);
        assert.deepEqual(users, [EARLIER_INPUT, "job-full"]);
        assert.ok((await contextText(fixture.host, id as string)).includes(EARLIER_INPUT));
    });

    it("starts a Compact invoked context with a compaction of the invoking context and the job prompt", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker();

        const [id] = await createInvokedConversations(fixture.host, {
            invokingId,
            callId: "call-1",
            agents: [request(fixture, "job-compact", "compact")],
            actor: fixture.actor,
        });

        const summarizing = fixture.requests.filter((messages) =>
            messages.some((message) => message.role === "user" && textOf(message).includes("job-compact")),
        );
        assert.ok(summarizing.length > 0, "the compaction ran with the job prompt as instructions");
        await waitForRequestsTo(fixture, "job-compact");
        const text = await contextText(fixture.host, id as string);
        assert.ok(text.includes(SUMMARY_TEXT));
        assert.ok(text.includes("job-compact"));
    });

    it("starts a Clean invoked context with only the job prompt", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker();

        const [id] = await createInvokedConversations(fixture.host, {
            invokingId,
            callId: "call-1",
            agents: [request(fixture, "job-clean", "clean")],
            actor: fixture.actor,
        });

        await waitForRequestsTo(fixture, "job-clean");
        const text = await contextText(fixture.host, id as string);
        assert.ok(text.includes("job-clean"));
        assert.equal(text.includes(EARLIER_INPUT), false);
    });

    for (const contextMode of ["full", "compact", "clean"] as const) {
        it(`starts the first seat record of a ${contextMode} invoked conversation without a previous seat`, async () => {
            const fixture = await createFixture();
            const invokingId = await fixture.startInvoker();

            const [id] = await createInvokedConversations(fixture.host, {
                invokingId,
                callId: "call-1",
                agents: [request(fixture, "alpha", contextMode)],
                actor: fixture.actor,
            });

            const record = await lastSeatRecord(fixture.host, id as string);
            assert.equal(record.previous, null);
            assert.equal((record.next as { role: string }).role, "invoked-alpha");
        });
    }

    it("throws InvocationDepthError naming the cap and creates nothing at the depth cap", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker({ depth: INVOCATION_DEPTH_CAP });
        const before = (await fixture.host.listConversations()).length;

        await assert.rejects(
            createInvokedConversations(fixture.host, {
                invokingId,
                callId: "call-1",
                agents: [request(fixture, "alpha")],
                actor: fixture.actor,
            }),
            (error: unknown) =>
                error instanceof InvocationDepthError &&
                error.cap === INVOCATION_DEPTH_CAP &&
                error.message.includes(String(INVOCATION_DEPTH_CAP)),
        );

        assert.equal((await fixture.host.listConversations()).length, before);
        assert.deepEqual((await readConversationMeta(fixture.host, invokingId))?.awaiting, []);
    });

    it("returns the same conversations and creates nothing when the invoking id and call id repeat", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker();
        const input = {
            invokingId,
            callId: "call-1",
            agents: [request(fixture, "alpha"), request(fixture, "beta")],
            actor: fixture.actor,
        };

        const original = await createInvokedConversations(fixture.host, input);
        const again = await createInvokedConversations(fixture.host, input);

        assert.deepEqual(again, original);
        assert.equal((await fixture.host.listConversations()).length, 3);
        assert.deepEqual((await readConversationMeta(fixture.host, invokingId))?.awaiting, original);
    });
});

async function waitForRequestsTo(fixture: Fixture, prompt: string): Promise<Message[][]> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        const found = fixture
            .requestsTo(prompt)
            .filter((messages) => !messages.some((m) => textOf(m) === SUMMARY_TEXT));
        if (found.length > 0) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No model request carried "${prompt}".`);
}

describe("parkConversation and continueParked", () => {
    it("clears the parked state and starts a run with the input when a parked conversation continues", async () => {
        const fixture = await createFixture();
        const invokingId = await fixture.startInvoker();
        await parkConversation(fixture.host, invokingId, { waitingFor: "answer", continueOn: "each" });
        assert.deepEqual((await readConversationMeta(fixture.host, invokingId))?.parked, {
            waitingFor: "answer",
            continueOn: "each",
        });

        const { submissionId } = await continueParked(fixture.host, invokingId, {
            content: "the answer",
            requestId: "answer-1",
        });

        assert.equal((await readConversationMeta(fixture.host, invokingId))?.parked, null);
        assert.equal((await waitForSubmission(fixture.host, submissionId, WAIT_MS)).state, "done");
        assert.ok((await contextText(fixture.host, invokingId)).includes("the answer"));
    });
});
