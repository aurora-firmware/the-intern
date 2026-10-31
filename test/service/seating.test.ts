import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    type Models,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import {
    changeSeat,
    createSeatedConversation,
    type JobLinks,
    readConversationMeta,
    SEAT_RECORD_KIND,
    type SeatActor,
} from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type FakeModel = FauxProviderRegistration;
type ModelId = "model-one" | "model-two";

const WAIT_MS = 10_000;
const context = BACKGROUND_CONTEXT;
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

const modelName = (fake: FakeModel, id: ModelId): string => `${fake.getModel().provider}/${id}`;

// One provider with two models; the answer names the model that gave it, and model-one answers after a delay.
function registerTwoModels(firstDelayMs: number, onFirstRequest: () => void): FakeModel {
    const registration = registerFauxProvider({ models: [{ id: "model-one" }, { id: "model-two" }] });
    const answer: FauxResponseFactory = async (_context, _options, _state, model) => {
        registration.appendResponses([answer]);
        if (model.id === "model-one") onFirstRequest();
        if (model.id === "model-one") await new Promise((resolve) => setTimeout(resolve, firstDelayMs));
        return fauxAssistantMessage(`from-${model.id}`);
    };
    registration.setResponses([answer]);
    return registration;
}

type Fixture = {
    fake: FakeModel;
    /** Settles when model-one has received its first request. */
    firstRequest: Promise<void>;
    open(): Promise<HarnessHost>;
    seatOn(id: ModelId, overrides?: Partial<Seat>): Seat;
};

async function createFixture(firstDelayMs = 0): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const firstRequest = Promise.withResolvers<void>();
    const fake = registerTwoModels(firstDelayMs, firstRequest.resolve);
    fakes.push(fake);
    const open = async (): Promise<HarnessHost> => {
        const host = await openHarnessHost({
            databaseFile: join(env.root, "state.sqlite"),
            models: modelsFor(fake),
            harnessSettings: {},
            extensions: [],
            defaultCwd: process.cwd(),
            logger: createLogger({ stream: { write: () => true } }),
        });
        hosts.push(host);
        return host;
    };
    const seatOn = (id: ModelId, overrides: Partial<Seat> = {}): Seat => ({
        role: "developer",
        model: modelName(fake, id),
        thinkingLevel: "low",
        workspace: env.root,
        instructions: "Write code.",
        tools: ["read", "bash"],
        skills: [],
        ...overrides,
    });
    return { fake, firstRequest: firstRequest.promise, open, seatOn };
}

const job: JobLinks = { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 };
const actor: SeatActor = { kind: "team_member", wayIn: "cli" };

async function agentOf(host: HarnessHost, conversationId: string) {
    return internalHarness(host).snapshot(AgentDoc, Number(conversationId) as ConversationId, context);
}

async function seatRecordsOf(host: HarnessHost, conversationId: string) {
    const page = await host.readEntries(conversationId, { limit: 100 });
    return page.entries.filter((entry) => entry.kind === SEAT_RECORD_KIND).map((entry) => entry.data);
}

describe("createSeatedConversation", () => {
    it("creates a conversation with the seat in its agent, the job links in its document and a first seat record", async () => {
        const { open, fake, seatOn } = await createFixture();
        const host = await open();
        const seat = seatOn("model-one");

        const { conversationId, created } = await createSeatedConversation(host, {
            scope: "start-job",
            key: "k1",
            job,
            seat,
            actor,
        });

        assert.equal(created, true);
        const agent = await agentOf(host, conversationId);
        assert.deepEqual(agent?.model, { provider: fake.getModel().provider, modelId: "model-one" });
        assert.equal(agent?.thinkingLevel, "low");
        assert.equal(agent?.cwd, seat.workspace);
        assert.deepEqual(agent?.tools, ["read", "bash"]);
        assert.deepEqual(await readConversationMeta(host, conversationId), {
            ...job,
            seat,
            awaiting: [],
            parked: null,
            held: [],
        });
        assert.deepEqual(await seatRecordsOf(host, conversationId), [
            {
                previous: null,
                next: {
                    role: "developer",
                    model: seat.model,
                    thinkingLevel: "low",
                    workspace: seat.workspace,
                },
                actor,
            },
        ]);
    });

    it("returns the same conversation and creates nothing when the scope and key repeat", async () => {
        const { open, seatOn } = await createFixture();
        const host = await open();
        const input = { scope: "start-job", key: "k1", job, seat: seatOn("model-one"), actor };

        const original = await createSeatedConversation(host, input);
        const again = await createSeatedConversation(host, input);

        assert.equal(again.created, false);
        assert.equal(again.conversationId, original.conversationId);
        assert.equal((await host.listConversations()).length, 1);
        assert.equal((await seatRecordsOf(host, original.conversationId)).length, 1);
    });

    it("omits the thinking level from the stored seat when the seat has none", async () => {
        const { open, seatOn } = await createFixture();
        const host = await open();
        const seat = seatOn("model-one", { thinkingLevel: undefined });

        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: "k1",
            job,
            seat,
            actor,
        });

        const [record] = (await seatRecordsOf(host, conversationId)) as { next: object }[];
        assert.equal("thinkingLevel" in record.next, false);
    });
});

describe("changeSeat", () => {
    it("lets a running model turn finish with the old seat and runs the next turn with the new one", async () => {
        const { open, fake, firstRequest, seatOn } = await createFixture(300);
        const host = await open();
        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: "k1",
            job,
            seat: seatOn("model-one"),
            actor,
        });
        const running = await submitInput(host, conversationId, {
            content: "one",
            requestId: "r1",
            busyMode: "reject",
        });

        await firstRequest;
        const newSeat = seatOn("model-two", { role: "reviewer", thinkingLevel: "high", workspace: process.cwd() });
        await changeSeat(host, conversationId, { seat: newSeat, actor });
        await waitForSubmission(host, running.submissionId, WAIT_MS);
        const next = await submitInput(host, conversationId, { content: "two", requestId: "r2", busyMode: "reject" });
        await waitForSubmission(host, next.submissionId, WAIT_MS);

        const replies = (await host.readContext(conversationId)).filter((entry) => entry.kind === "pi.assistant");
        assert.match(JSON.stringify(replies[0]?.data), /from-model-one/);
        assert.match(JSON.stringify(replies[1]?.data), /from-model-two/);
        const agent = await agentOf(host, conversationId);
        assert.deepEqual(agent?.model, { provider: fake.getModel().provider, modelId: "model-two" });
        assert.equal(agent?.thinkingLevel, "high");
        assert.equal(agent?.cwd, process.cwd());
    });

    it("writes a seat record with the previous and new seat, actor, context mode and note", async () => {
        const { open, fake, seatOn } = await createFixture();
        const host = await open();
        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: "k1",
            job,
            seat: seatOn("model-one"),
            actor,
        });
        const newSeat = seatOn("model-two", { role: "reviewer", thinkingLevel: undefined, workspace: "/elsewhere" });
        const agentActor: SeatActor = { kind: "agent", conversationId: "7", role: "lead" };

        await changeSeat(host, conversationId, {
            seat: newSeat,
            actor: agentActor,
            contextMode: "clean",
            note: "review",
        });

        const records = await seatRecordsOf(host, conversationId);
        assert.deepEqual(records[1], {
            previous: {
                role: "developer",
                model: modelName(fake, "model-one"),
                thinkingLevel: "low",
                workspace: await readSeatWorkspace(host, conversationId, 0),
            },
            next: { role: "reviewer", model: modelName(fake, "model-two"), workspace: "/elsewhere" },
            actor: agentActor,
            contextMode: "clean",
            note: "review",
        });
        assert.deepEqual((await readConversationMeta(host, conversationId))?.seat, JSON.parse(JSON.stringify(newSeat)));
    });

    it("writes a record without context mode or note when none is given", async () => {
        const { open, seatOn } = await createFixture();
        const host = await open();
        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: "k1",
            job,
            seat: seatOn("model-one"),
            actor,
        });

        await changeSeat(host, conversationId, { seat: seatOn("model-two"), actor });

        const record = (await seatRecordsOf(host, conversationId))[1] as object;
        assert.equal("contextMode" in record, false);
        assert.equal("note" in record, false);
    });
});

async function readSeatWorkspace(host: HarnessHost, conversationId: string, index: number): Promise<string> {
    const [record] = (await seatRecordsOf(host, conversationId)).slice(index, index + 1) as {
        next: { workspace: string };
    }[];
    return record.next.workspace;
}

describe("conversation metadata after reopening", () => {
    it("reads the same metadata and seat records when the host is closed and opened again", async () => {
        const { open, seatOn } = await createFixture();
        const firstHost = await open();
        const { conversationId } = await createSeatedConversation(firstHost, {
            scope: "start-job",
            key: "k1",
            job,
            seat: seatOn("model-one"),
            actor,
        });
        await changeSeat(firstHost, conversationId, { seat: seatOn("model-two"), actor, note: "n" });
        const meta = await readConversationMeta(firstHost, conversationId);
        const records = await seatRecordsOf(firstHost, conversationId);
        await firstHost.close();

        const secondHost = await open();

        assert.deepEqual(await readConversationMeta(secondHost, conversationId), meta);
        assert.deepEqual(await seatRecordsOf(secondHost, conversationId), records);
    });

    it("returns undefined for a conversation that has no metadata", async () => {
        const { open } = await createFixture();
        const host = await open();

        assert.equal(await readConversationMeta(host, "999"), undefined);
    });
});
