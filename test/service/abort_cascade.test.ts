import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type ConversationId, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { abortJobConversations, abortWithAwaited, createInvokedConversations } from "../../src/host/invocation.ts";
import { startReportDelivery } from "../../src/host/reports.ts";
import {
    conversationMetaDoc,
    createSeatedConversation,
    readConversationMeta,
    type SeatActor,
} from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { conversationControlOperations } from "../../src/service/conversation_control_operations.ts";
import { createCatalogue } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_ATTEMPTS = 400;
const POLL_PAUSE_MS = 25;
const SETTLE_PAUSE_MS = 300;
const ctx = BACKGROUND_CONTEXT;

type FakeModel = ReturnType<typeof createFakeModel>;

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

// Holds a tool call open until the abort reaches it, so a conversation stays busy until it is aborted.
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Fixture = {
    readonly host: HarnessHost;
    actor: SeatActor;
    seat: Seat;
    start(jobId: string, prompt: string): Promise<string>;
    invoke(invokingId: string, callId: string, names: string[], parked?: boolean): Promise<string[]>;
    inputsOf(id: string): Promise<number>;
    waitUntilBusy(ids: string[]): Promise<void>;
    busy(id: string): Promise<boolean>;
    reportsTo(id: string, text: string): Promise<string[]>;
    stopDelivery(): void;
    reopen(): Promise<void>;
};

// A prompt starting "idle" is answered at once; every other prompt calls the wait tool and keeps its conversation busy.
async function openFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel((transcript) => {
        const hasToolResult = transcript.some((message) => message.role === "toolResult");
        const last = transcript.filter((message) => message.role === "user").at(-1)?.text ?? "";
        if (last.startsWith("idle") || hasToolResult) return "ok";
        return { toolCall: { name: "wait", arguments: {} } };
    });
    fakes.push(fake);
    const openHost = async () => {
        const opened = await openHarnessHost({
            databaseFile: join(env.root, "state.sqlite"),
            models: modelsFor(fake),
            harnessSettings: {},
            extensions: [waitExtension],
            defaultCwd: process.cwd(),
            logger: createLogger({ stream: { write: () => true } }),
        });
        hosts.push(opened);
        deliveries.push(await startReportDelivery(opened, { logger: createLogger({ stream: { write: () => true } }) }));
        return opened;
    };
    let host = await openHost();
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace: env.root,
        instructions: "Work.",
        tools: ["wait"],
        skills: [],
    };
    const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
    const busy = async (id: string) => (await host.conversationInfo(id))?.busy === true;
    const waitUntilBusy = async (ids: string[]) => {
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
            const states = await Promise.all(ids.map(busy));
            if (states.every(Boolean)) return;
            await pause(POLL_PAUSE_MS);
        }
        assert.fail(`conversations ${ids.join(", ")} did not all become busy`);
    };
    const start = async (jobId: string, prompt: string) => {
        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: `${jobId}-${prompt}-${Math.random()}`,
            job: { jobId, isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
            seat,
            actor,
        });
        await submitInput(host, conversationId, {
            content: prompt,
            requestId: `r-${conversationId}`,
            busyMode: "followUp",
        });
        return conversationId;
    };
    const invoke = (invokingId: string, callId: string, names: string[], parked = false) =>
        createInvokedConversations(host, {
            invokingId,
            callId,
            agents: names.map((name) => ({ seat, contextMode: "clean" as const, jobPrompt: `job ${name}` })),
            actor,
            ...(parked && { parked: { waitingFor: "reports" as const, continueOn: "each" as const } }),
        });
    // Counts the user messages in a conversation: a delivered report is one of them.
    const inputsOf = async (id: string) =>
        (await host.readEntries(id, { limit: 1000 })).entries.filter((entry) =>
            JSON.stringify(entry.data).includes('"role":"user"'),
        ).length;
    // The user messages of a conversation that contain the text: a delivered report is one of them.
    const reportsTo = async (id: string, text: string) =>
        (await host.readEntries(id, { limit: 1000 })).entries
            .map((entry) => JSON.stringify(entry.data))
            .filter((data) => data.includes('"role":"user"') && data.includes(text));
    const stopDelivery = () => {
        for (const delivery of deliveries.splice(0)) delivery.stop();
    };
    // Closes the host and opens the same database again, with report delivery running.
    const reopen = async () => {
        stopDelivery();
        await host.close();
        hosts.splice(hosts.indexOf(host), 1);
        host = await openHost();
    };
    return {
        get host() {
            return host;
        },
        actor,
        seat,
        start,
        invoke,
        inputsOf,
        waitUntilBusy,
        busy,
        reportsTo,
        stopDelivery,
        reopen,
    };
}

describe("abortWithAwaited", () => {
    it("aborts the awaited conversations and the ones they await in turn", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "lead");
        const [child] = await fixture.invoke(lead, "c1", ["child"]);
        const [grandchild] = await fixture.invoke(child as string, "c2", ["grandchild"]);
        const all = [lead, child as string, grandchild as string];
        await fixture.waitUntilBusy(all);

        const aborted = await abortWithAwaited(fixture.host, lead);

        assert.deepEqual([...aborted].sort(), [...all].sort());
        for (const id of all) assert.equal(await fixture.busy(id), false);
    });

    it("aborts the awaited conversations of a parked invoking conversation", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "idle");
        const [child] = await fixture.invoke(lead, "c1", ["child"], true);
        await fixture.waitUntilBusy([child as string]);
        assert.equal((await readConversationMeta(fixture.host, lead))?.parked?.waitingFor, "reports");

        const aborted = await abortWithAwaited(fixture.host, lead);

        assert.deepEqual([...aborted].sort(), [lead, child as string].sort());
        assert.equal(await fixture.busy(child as string), false);
    });

    it("leaves an invoked conversation that has already reported untouched", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "lead");
        const [reported, waiting] = await fixture.invoke(lead, "c1", ["reported", "waiting"]);
        await fixture.waitUntilBusy([lead, reported as string, waiting as string]);
        await internalHarness(fixture.host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, Number(lead) as ConversationId);
            meta.awaiting = meta.awaiting.filter((id) => id !== reported);
        }, ctx);

        const aborted = await abortWithAwaited(fixture.host, lead);

        assert.deepEqual([...aborted].sort(), [lead, waiting as string].sort());
        assert.equal(await fixture.busy(reported as string), true);
        assert.equal(await fixture.busy(waiting as string), false);
    });
});

describe("abortJobConversations", () => {
    it("aborts every conversation of the job and none of another job", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "lead");
        const [child] = await fixture.invoke(lead, "c1", ["child"]);
        const other = await fixture.start("job-2", "lead");
        const ofJob = [lead, child as string];
        await fixture.waitUntilBusy([...ofJob, other]);

        const aborted = await abortJobConversations(fixture.host, "job-1");

        assert.deepEqual([...aborted].sort(), [...ofJob].sort());
        for (const id of ofJob) assert.equal(await fixture.busy(id), false);
        await pause(SETTLE_PAUSE_MS);
        assert.equal(await fixture.busy(other), true);
    });
});

async function assertNothingLeft(fixture: Fixture, ids: string[], inputsBefore: number[]) {
    await pause(SETTLE_PAUSE_MS);
    for (const [index, id] of ids.entries()) {
        const meta = await readConversationMeta(fixture.host, id);
        assert.equal(meta?.parked, null, `${id} is not parked`);
        assert.deepEqual(meta?.awaiting, [], `${id} awaits nothing`);
        assert.deepEqual(meta?.held, [], `${id} holds nothing`);
        assert.equal(await fixture.busy(id), false, `${id} is not busy`);
        assert.equal(await fixture.inputsOf(id), inputsBefore[index], `${id} received no input`);
    }
}

describe("an abort with report delivery running", () => {
    for (const isParked of [false, true]) {
        const kind = isParked ? "parked" : "steerable";

        it(`leaves nothing parked, awaited or held after abortWithAwaited on a ${kind} invoker`, async () => {
            const fixture = await openFixture();
            const lead = await fixture.start("job-1", isParked ? "idle" : "lead");
            const [child] = await fixture.invoke(lead, "c1", ["child"], isParked);
            const [grandchild] = await fixture.invoke(child as string, "c2", ["grandchild"]);
            const all = [lead, child as string, grandchild as string];
            await fixture.waitUntilBusy(all.slice(1));
            const inputsBefore = await Promise.all(all.map(fixture.inputsOf));

            await abortWithAwaited(fixture.host, lead);

            await assertNothingLeft(fixture, all, inputsBefore);
        });

        it(`leaves nothing parked, awaited or held after abortJobConversations on a ${kind} invoker`, async () => {
            const fixture = await openFixture();
            const lead = await fixture.start("job-1", isParked ? "idle" : "lead");
            const [child] = await fixture.invoke(lead, "c1", ["child"], isParked);
            const all = [lead, child as string];
            await fixture.waitUntilBusy(all.slice(1));
            const inputsBefore = await Promise.all(all.map(fixture.inputsOf));

            await abortJobConversations(fixture.host, "job-1");

            await assertNothingLeft(fixture, all, inputsBefore);
        });
    }
});

describe("conversations.abort", () => {
    it("aborts the conversations the aborted conversation awaits", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "lead");
        const [child] = await fixture.invoke(lead, "c1", ["child"]);
        await fixture.waitUntilBusy([lead, child as string]);
        const catalogue = createCatalogue(conversationControlOperations, {
            context: { host: fixture.host },
            phase: () => "ready",
            logger: createLogger({ stream: { write: () => true } }),
        });

        await catalogue.invoke("conversations.abort", { conversationId: lead }, { actor: { kind: "team_member" } });

        assert.equal(await fixture.busy(child as string), false);
        assert.equal(await fixture.busy(lead), false);
    });
});

async function waitFor(isDone: () => Promise<boolean>, what: string): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (await isDone()) return;
        await pause(POLL_PAUSE_MS);
    }
    assert.fail(`timed out waiting for ${what}`);
}

// An invoked conversation that answered "ok" at once and then awaits the wait-tool conversation it invoked, so it is
// not busy and has a last answer while its invoker still awaits it.
async function invokeAnsweredAndWaiting(fixture: Fixture, invokerId: string, isParked: boolean) {
    const [answered] = await createInvokedConversations(fixture.host, {
        invokingId: invokerId,
        callId: "c1",
        agents: [{ seat: fixture.seat, contextMode: "clean", jobPrompt: "idle answer" }],
        actor: fixture.actor,
    });
    const answeredId = answered as string;
    const [child] = await fixture.invoke(answeredId, "c2", ["child"], isParked);
    await fixture.waitUntilBusy([child as string]);
    await waitFor(async () => !(await fixture.busy(answeredId)), "the invoked conversation to finish its run");
    return answeredId;
}

describe("a lone abort of an invoked conversation with report delivery running", () => {
    it("reports an aborted running invoked conversation to its invoker once", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "idle lead");
        const [invoked] = await fixture.invoke(lead, "c1", ["worker"]);
        await fixture.waitUntilBusy([invoked as string]);

        await abortWithAwaited(fixture.host, invoked as string);

        const text = `Conversation ${invoked} (developer) was aborted.`;
        await waitFor(async () => (await fixture.reportsTo(lead, text)).length > 0, "the aborted report");
        await pause(SETTLE_PAUSE_MS);
        assert.equal((await fixture.reportsTo(lead, text)).length, 1);
        assert.deepEqual((await readConversationMeta(fixture.host, lead))?.awaiting, []);
    });

    for (const isParked of [false, true]) {
        const kind = isParked ? "parked" : "idle";

        it(`reports an aborted ${kind} invoked conversation with its last answer`, async () => {
            const fixture = await openFixture();
            const lead = await fixture.start("job-1", "idle lead");
            const answeredId = await invokeAnsweredAndWaiting(fixture, lead, isParked);
            assert.equal((await readConversationMeta(fixture.host, answeredId))?.parked !== null, isParked);

            await abortWithAwaited(fixture.host, answeredId);

            const text = `Conversation ${answeredId} (developer) was aborted.`;
            await waitFor(async () => (await fixture.reportsTo(lead, text)).length > 0, "the aborted report");
            await pause(SETTLE_PAUSE_MS);
            const reports = await fixture.reportsTo(lead, text);
            assert.equal(reports.length, 1);
            assert.ok((reports[0] as string).includes("Its last answer:"));
            assert.ok((reports[0] as string).includes("ok"));
            assert.deepEqual((await readConversationMeta(fixture.host, lead))?.awaiting, []);
        });
    }

    it("reports an aborted invoked conversation without a last answer as the first sentence alone", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "idle lead");
        const [invoked] = await fixture.invoke(lead, "c1", ["worker"]);
        await fixture.waitUntilBusy([invoked as string]);
        await internalHarness(fixture.host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, Number(invoked) as ConversationId);
            meta.parked = { waitingFor: "answer", continueOn: "each" };
        }, ctx);

        await abortWithAwaited(fixture.host, invoked as string);

        const text = `Conversation ${invoked} (developer) was aborted.`;
        await waitFor(async () => (await fixture.reportsTo(lead, text)).length > 0, "the aborted report");
        for (const report of await fixture.reportsTo(lead, text)) assert.ok(!report.includes("Its last answer:"));
    });

    it("continues a parked invoker with the aborted report", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "idle lead");
        const [invoked] = await fixture.invoke(lead, "c1", ["worker"], true);
        await fixture.waitUntilBusy([invoked as string]);
        assert.notEqual((await readConversationMeta(fixture.host, lead))?.parked, null);

        await abortWithAwaited(fixture.host, invoked as string);

        const text = `Conversation ${invoked} (developer) was aborted.`;
        await waitFor(async () => (await fixture.reportsTo(lead, text)).length > 0, "the aborted report");
        const meta = await readConversationMeta(fixture.host, lead);
        assert.equal(meta?.parked, null);
        assert.deepEqual(meta?.awaiting, []);
    });

    it("delivers the aborted report once when the host reopens after the abort and before the delivery", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "idle lead");
        const answeredId = await invokeAnsweredAndWaiting(fixture, lead, false);
        fixture.stopDelivery();

        await abortWithAwaited(fixture.host, answeredId);
        await pause(SETTLE_PAUSE_MS);
        const text = `Conversation ${answeredId} (developer) was aborted.`;
        assert.equal((await fixture.reportsTo(lead, text)).length, 0);
        await fixture.reopen();

        await waitFor(async () => (await fixture.reportsTo(lead, text)).length > 0, "the aborted report");
        await pause(SETTLE_PAUSE_MS);
        assert.equal((await fixture.reportsTo(lead, text)).length, 1);
        assert.deepEqual((await readConversationMeta(fixture.host, lead))?.awaiting, []);
    });

    it("reports nothing for a conversation aborted by the cascade from its invoker", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("job-1", "idle lead");
        const answeredId = await invokeAnsweredAndWaiting(fixture, lead, false);
        const before = await fixture.inputsOf(lead);

        await abortWithAwaited(fixture.host, lead);

        await pause(SETTLE_PAUSE_MS);
        assert.equal(await fixture.inputsOf(lead), before);
        assert.equal((await readConversationMeta(fixture.host, answeredId))?.aborted, false);
    });
});
