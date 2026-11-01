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
    host: HarnessHost;
    actor: SeatActor;
    seat: Seat;
    start(jobId: string, prompt: string): Promise<string>;
    invoke(invokingId: string, callId: string, names: string[], parked?: boolean): Promise<string[]>;
    waitUntilBusy(ids: string[]): Promise<void>;
    busy(id: string): Promise<boolean>;
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
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [waitExtension],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
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
            ...(parked && { parked: { waitingFor: "reports" as const, continueOn: "all" as const } }),
        });
    return { host, actor, seat, start, invoke, waitUntilBusy, busy };
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
