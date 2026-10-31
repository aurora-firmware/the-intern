import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineDoc } from "@earendil-works/pi-durable";
import { type Admission, createAdmission } from "../../src/admission/admission.ts";
import { createAdmissionGate } from "../../src/admission/admission_extension.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    compactConversation,
    resetConversation,
    submitInput,
    waitForSubmission,
} from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import {
    type ConversationStatus,
    conversationReadOperations,
    conversationStatus,
} from "../../src/service/conversation_read_operations.ts";
import { type Caller, createCatalogue, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SETTLE_TIMEOUT_MS = 20_000;
const BUSY_DELAY_MS = 400;
const POLL_ATTEMPTS = 200;
const POLL_PAUSE_MS = 25;
const caller: Caller = { actor: { kind: "team_member" } };

// The daemon documents (S-002 Definitions, "Database"), declared again here to read what the product stored.
const daemonDocuments = ["intern.admission", "intern.versions", "intern.idempotency"].map((kind) =>
    defineDoc<Record<string, unknown>>({
        kind,
        version: 1,
        scope: "session",
        initial: () => ({}),
        checkpointWhen: () => false,
    }),
);

type FakeModel = ReturnType<typeof createFakeModel>;
type Fixture = {
    host: HarnessHost;
    admission: Admission;
    call(name: string, input?: unknown): Promise<unknown>;
    newConversation(): Promise<string>;
    send(conversationId: string, content: string): Promise<string>;
    settle(submissionId: string): Promise<void>;
};

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

type FixtureOptions = { capacity?: number; delayMs?: number };

async function openFixture(options: FixtureOptions = {}): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => options.delayMs ?? 0 });
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const gate = createAdmissionGate();
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: { compaction: { keepRecentTokens: 1 } },
        extensions: [gate.extension],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const admission = createAdmission({ host, capacity: options.capacity ?? 1, logger, gate });
    admissions.push(admission);
    await admission.restore();
    host.resume();
    const catalogue = createCatalogue(conversationReadOperations, {
        context: { host, admission },
        phase: () => "ready",
        logger,
    });
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    let requestCount = 0;
    return {
        host,
        admission,
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
        async settle(submissionId) {
            assert.equal((await waitForSubmission(host, submissionId, SETTLE_TIMEOUT_MS)).state, "done");
        },
    };
}

async function pollUntil(isDone: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (await isDone()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
    }
    assert.fail("the expected condition never held");
}

type EntriesResult = { entries: { id: string; kind: string }[]; next?: string };

async function exchange(fixture: Fixture, conversationId: string, content: string): Promise<void> {
    await fixture.settle(await fixture.send(conversationId, content));
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
        return error.code;
    }
    return assert.fail("expected the call to reject");
}

describe("conversationStatus", () => {
    const admission = {
        capacity: 1,
        active: ["a"],
        waiting: [{ conversationId: "w", position: 1 }],
    };

    it("is waiting for a worker thread when admission lists the conversation as waiting", () => {
        assert.equal(conversationStatus({ id: "w", busy: true }, admission), "waiting for a worker thread");
    });

    it("is running when the conversation is busy and not waiting", () => {
        assert.equal(conversationStatus({ id: "a", busy: true }, admission), "running");
    });

    it("is idle when the conversation is neither busy nor waiting", () => {
        const status: ConversationStatus = conversationStatus({ id: "i", busy: false }, admission);
        assert.equal(status, "idle");
    });
});

describe("conversations.list and conversations.get", () => {
    it("lists every conversation as waiting, running or idle", async () => {
        const fixture = await openFixture({ capacity: 1, delayMs: BUSY_DELAY_MS });
        const [running, waiting, idle] = [
            await fixture.newConversation(),
            await fixture.newConversation(),
            await fixture.newConversation(),
        ];
        const first = await fixture.send(running, "one");
        await pollUntil(async () => fixture.admission.state().active.includes(running));
        const second = await fixture.send(waiting, "two");
        await pollUntil(async () => fixture.admission.state().waiting.some((w) => w.conversationId === waiting));

        const listed = (await fixture.call("conversations.list")) as { id: string; status: string }[];
        const statusOf = (id: string) => listed.find((conversation) => conversation.id === id)?.status;

        assert.equal(listed.length, 3);
        assert.equal(statusOf(running), "running");
        assert.equal(statusOf(waiting), "waiting for a worker thread");
        assert.equal(statusOf(idle), "idle");
        assert.deepEqual(await fixture.call("conversations.get", { conversationId: waiting }), {
            id: waiting,
            status: "waiting for a worker thread",
        });
        await fixture.settle(first);
        await fixture.settle(second);
    });

    it("rejects get with not_found for an unknown id", async () => {
        const fixture = await openFixture();
        assert.equal(await rejectionCode(fixture.call("conversations.get", { conversationId: "999" })), "not_found");
    });
});

describe("conversations.entries", () => {
    it("pages the stored entries oldest first with a cursor, including entries before a reset", async () => {
        const fixture = await openFixture();
        const id = await fixture.newConversation();
        await exchange(fixture, id, "before");
        await resetConversation(fixture.host, id);
        await exchange(fixture, id, "after");
        const everything: EntriesResult["entries"] = [];
        let after: string | undefined;
        let pages = 0;

        do {
            const page = (await fixture.call("conversations.entries", {
                conversationId: id,
                limit: 2,
                ...(after !== undefined && { after }),
            })) as EntriesResult;
            assert.ok(page.entries.length <= 2);
            everything.push(...page.entries);
            after = page.next;
            pages++;
        } while (after !== undefined);

        const unpaged = (await fixture.call("conversations.entries", { conversationId: id })) as EntriesResult;
        assert.ok(pages > 1);
        assert.deepEqual(everything, unpaged.entries);
        assert.equal(unpaged.next, undefined);
        const kinds = unpaged.entries.map((entry) => entry.kind);
        assert.ok(kinds.indexOf("pi.reset") > kinds.indexOf("pi.user"));
        assert.ok(kinds.lastIndexOf("pi.user") > kinds.indexOf("pi.reset"));
    });

    it("keeps entries from before a compaction", async () => {
        const fixture = await openFixture();
        const id = await fixture.newConversation();
        await exchange(fixture, id, "one");
        await exchange(fixture, id, "two");
        await compactConversation(fixture.host, id);

        const result = (await fixture.call("conversations.entries", { conversationId: id })) as EntriesResult;

        const kinds = result.entries.map((entry) => entry.kind);
        assert.equal(kinds.filter((kind) => kind === "pi.user").length, 2);
        assert.ok(kinds.includes("pi.compaction"));
    });

    it("rejects limits outside 1 to 500 with invalid_input and an unknown id with not_found", async () => {
        const fixture = await openFixture();
        const id = await fixture.newConversation();
        for (const limit of [0, 501, -1, 1.5, "10"]) {
            assert.equal(
                await rejectionCode(fixture.call("conversations.entries", { conversationId: id, limit })),
                "invalid_input",
                `limit ${String(limit)}`,
            );
        }
        assert.equal(
            await rejectionCode(fixture.call("conversations.entries", { conversationId: "999" })),
            "not_found",
        );
    });
});

describe("conversations.context", () => {
    it("returns only the entries the model sees now after a reset", async () => {
        const fixture = await openFixture();
        const id = await fixture.newConversation();
        await exchange(fixture, id, "before");
        await resetConversation(fixture.host, id);
        await exchange(fixture, id, "after");

        const context = (await fixture.call("conversations.context", {
            conversationId: id,
        })) as EntriesResult["entries"];
        const stored = (await fixture.call("conversations.entries", { conversationId: id })) as EntriesResult;

        const texts = JSON.stringify(context);
        assert.ok(texts.includes("after"));
        assert.ok(!texts.includes("before"));
        assert.ok(context.length < stored.entries.length);
    });

    it("rejects an unknown id with not_found", async () => {
        const fixture = await openFixture();
        assert.equal(
            await rejectionCode(fixture.call("conversations.context", { conversationId: "999" })),
            "not_found",
        );
    });
});

describe("read operations leave state unchanged", () => {
    it("is read kind for all four operations", () => {
        assert.deepEqual(
            conversationReadOperations.map((operation) => operation.kind),
            ["read", "read", "read", "read"],
        );
    });

    it("changes no conversation's entries and no daemon document when every operation runs", async () => {
        const fixture = await openFixture();
        const ids = [await fixture.newConversation(), await fixture.newConversation()];
        for (const id of ids) await exchange(fixture, id, "hello");
        const harness = internalHarness(fixture.host);
        const snapshot = async () => ({
            entries: await Promise.all(ids.map((id) => fixture.call("conversations.entries", { conversationId: id }))),
            documents: await Promise.all(daemonDocuments.map((doc) => harness.snapshot(doc, BACKGROUND_CONTEXT))),
        });
        const before = await snapshot();

        await fixture.call("conversations.list");
        for (const id of ids) {
            await fixture.call("conversations.get", { conversationId: id });
            await fixture.call("conversations.entries", { conversationId: id, limit: 1 });
            await fixture.call("conversations.context", { conversationId: id });
        }

        assert.deepEqual(await snapshot(), before);
        assert.ok(before.documents.some((document) => document !== undefined));
    });
});
