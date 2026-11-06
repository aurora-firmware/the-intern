import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool, InboxDoc } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { setJobStatusCheck } from "../../src/host/job_section.ts";
import { createSeatedConversation, readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import type { JobStatus } from "../../src/jobs/job_model.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createFakeModel } from "./fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

export const POLL_ATTEMPTS = 400;
export const POLL_PAUSE_MS = 25;

type FakeModel = ReturnType<typeof createFakeModel>;

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: FakeModel[] = [];

/** Closes every host and removes every fixture opened since the last call. */
export async function disposeFixtures(): Promise<void> {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
}

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

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A prompt starting "idle" is answered at once; every other prompt calls the wait tool and keeps its conversation busy.
export async function openFixture(status: JobStatus | undefined = "in_progress") {
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
        extensions: [defineExtension({ name: "wait", tools: [waitTool] })],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    if (status !== undefined) setJobStatusCheck(host, async () => status);
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace: env.root,
        instructions: "Work.",
        tools: ["wait"],
        skills: [],
    };
    const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
    const start = async (prompt: string, isLead = true) => {
        const { conversationId } = await createSeatedConversation(host, {
            scope: "start-job",
            key: `${prompt}-${Math.random()}`,
            job: { jobId: "job-1", isLead, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
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
    const invokeAwaited = (invokingId: string) =>
        createInvokedConversations(host, {
            invokingId,
            callId: "c2",
            agents: [{ seat, contextMode: "clean" as const, jobPrompt: "job child" }],
            actor,
        });
    // No public path leaves input queued on an idle conversation, so the test places one in its inbox.
    const queueInput = (id: string) =>
        internalHarness(host).commit(async (tx) => {
            const conversationId = Number(id) as never;
            const submission = await tx.createSubmission({ conversationId, type: "input", status: "queued" });
            (await tx.doc(InboxDoc, conversationId)).items.push({
                id: submission.id,
                mode: "followUp",
                content: "queued" as never,
            });
        }, BACKGROUND_CONTEXT);
    const invokeParked = (invokingId: string) =>
        createInvokedConversations(host, {
            invokingId,
            callId: "c1",
            agents: [{ seat, contextMode: "clean" as const, jobPrompt: "job child" }],
            actor,
            parked: { waitingFor: "reports" as const, continueOn: "each" as const },
        });
    const waitUntil = async (what: string, condition: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
            if (await condition()) return;
            await pause(POLL_PAUSE_MS);
        }
        assert.fail(`${what} did not happen`);
    };
    const waitUntilBusy = (id: string) =>
        waitUntil(`${id} busy`, async () => (await host.conversationInfo(id))?.busy === true);
    const waitUntilIdle = (id: string) =>
        waitUntil(`${id} idle`, async () => (await host.conversationInfo(id))?.busy === false);
    // The lead is busy before its run reaches the wait tool; its newest entry is steady once it waits there.
    const waitUntilSteady = async (id: string) => {
        let previous: string | null | undefined;
        await waitUntil(`${id} steady`, async () => {
            const newest = await host.readNewestEntryId(id);
            const isSteady = newest === previous;
            previous = newest;
            await pause(POLL_PAUSE_MS * 2);
            return isSteady;
        });
    };
    const stoppedOf = async (id: string) => (await readConversationMeta(host, id))?.stopped;
    return {
        host,
        start,
        invokeParked,
        invokeAwaited,
        queueInput,
        waitUntilBusy,
        waitUntilIdle,
        waitUntilSteady,
        stoppedOf,
    };
}
