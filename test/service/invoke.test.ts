import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    fauxAssistantMessage,
    fauxToolCall,
    type JsonObject,
    type Message,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { INVOCATION_DEPTH_CAP } from "../../src/daemon/constants.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "cli" } };
const requestOrigin = { kind: "request", wayIn: "cli" } as const;

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const textOf = (message: Message | undefined): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};

type StartOptions = {
    /** The invoke calls the lead makes on its first request, as one model turn. */
    leadCalls: { agents: readonly unknown[]; mode: "steerable" | "parked" }[];
    workerThreadCount?: number;
    /** Invoked agents wait on their first request until the test calls `release()`. */
    isInvokedHeld?: boolean;
};

// The tool's parameter is named `then`; one place builds it so the lint exception stays single.
const invokeCall = (spec: { agents: readonly unknown[]; mode: "steerable" | "parked" }): JsonObject => ({
    agents: [...spec.agents] as JsonObject[],
    // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
    then: spec.mode,
});

const invokedAgent = (jobPrompt: string, role = "gp") => ({ role, contextMode: "clean", jobPrompt });

async function start(options: StartOptions) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const toolResults: string[] = [];
    const leadRequests: Message[][] = [];
    let arrivals = 0;
    let release = (): void => {};
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        const users = context.messages.filter((message) => message.role === "user").map(textOf);
        const last = users.at(-1) ?? "";
        const results = context.messages.filter((message) => message.role === "toolResult").map(textOf);
        if (results.length > 0) toolResults.push(...results);
        if (last.startsWith("lead")) {
            leadRequests.push(context.messages);
            if (results.length > 0) return fauxAssistantMessage("done");
            const calls = options.leadCalls.map((args) => fauxToolCall("invoke", invokeCall(args)));
            return fauxAssistantMessage(calls, { stopReason: "toolUse" });
        }
        if (last.startsWith("dive") && results.length === 0) {
            return fauxAssistantMessage([fauxToolCall("invoke", invokeCall(diveArguments))], { stopReason: "toolUse" });
        }
        if (last.startsWith("job") && options.isInvokedHeld === true && results.length === 0) {
            arrivals += 1;
            await barrier;
        }
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, probe],
        operations: agents.operations,
        ...(options.workerThreadCount !== undefined && { workerThreadCount: options.workerThreadCount }),
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const ctx = captured as ServiceContext;
    return {
        ctx,
        toolResults,
        leadRequests,
        release,
        arrivals: () => arrivals,
        startLead: (firstInput: string, jobId = "job-1") =>
            daemon.catalogue.invoke("jobs.startLead", { jobId, firstInput, origin: requestOrigin }, caller) as Promise<{
                conversationId: string;
            }>,
        status: () =>
            daemon.catalogue.invoke("daemon.status", {}, caller) as Promise<{ workerThreads: { inUse: number } }>,
    };
}

const diveArguments = { agents: [invokedAgent("dive deeper")], mode: "steerable" } as const;

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const conversationIds = async (ctx: ServiceContext) => (await ctx.host.listConversations()).map((info) => info.id);

describe("the invoke tool", () => {
    it("runs two invoked agents in parallel as conversations of the invoker's job", async () => {
        const started = await start({
            leadCalls: [{ agents: [invokedAgent("job A"), invokedAgent("job B")], mode: "steerable" }],
            isInvokedHeld: true,
        });

        const { conversationId } = await started.startLead("lead work");

        // Both invoked agents' requests are in flight at once, each held on a worker thread of its own.
        await waitFor(() => started.arrivals() === 2, "both invoked agents to start");
        assert.ok((await started.status()).workerThreads.inUse >= 2, "each invoked agent holds a worker thread");
        assert.equal((await conversationIds(started.ctx)).length, 3);
        const invokedIds = (await conversationIds(started.ctx)).filter((id) => id !== conversationId);
        for (const id of invokedIds) {
            const meta = await readConversationMeta(started.ctx.host, id);
            assert.equal(meta?.jobId, "job-1");
            assert.equal(meta?.invokedBy, conversationId);
            assert.equal(meta?.depth, 1);
        }
        started.release();
        await waitFor(async () => (await started.status()).workerThreads.inUse === 0, "every run to finish");
    });

    it("returns the invoked conversation ids and continues the invoking run when steerable", async () => {
        const started = await start({
            leadCalls: [{ agents: [invokedAgent("job A"), invokedAgent("job B")], mode: "steerable" }],
        });

        const { conversationId } = await started.startLead("lead work");
        await waitFor(() => started.leadRequests.length >= 2, "the lead's request after the tool result");

        const invokedIds = (await conversationIds(started.ctx)).filter((id) => id !== conversationId);
        assert.equal(invokedIds.length, 2);
        const result = started.toolResults.join("\n");
        for (const id of invokedIds) assert.ok(result.includes(id), `the result names ${id}: ${result}`);
        assert.equal((await readConversationMeta(started.ctx.host, conversationId))?.parked, null);
    });

    it("ends the run, parks to continue on each report and frees the worker thread when parked", async () => {
        const started = await start({
            leadCalls: [{ agents: [invokedAgent("job A")], mode: "parked" }],
            workerThreadCount: 1,
        });

        const { conversationId } = await started.startLead("lead work");

        // With one worker thread, the invoked agent can only run once the parked lead has freed it.
        await waitFor(async () => {
            const [invokedId] = (await conversationIds(started.ctx)).filter((id) => id !== conversationId);
            return invokedId !== undefined && (await started.ctx.host.readContext(invokedId)).length >= 2;
        }, "the invoked agent to answer");
        assert.deepEqual((await readConversationMeta(started.ctx.host, conversationId))?.parked, {
            waitingFor: "reports",
            continueOn: "each",
        });
        assert.equal(started.leadRequests.length, 1, "the parked run asked for no further model turn");
    });

    it("refuses an invocation past the depth cap with an error naming the cap and continues the run", async () => {
        const started = await start({ leadCalls: [{ agents: [invokedAgent("dive deeper")], mode: "steerable" }] });

        await started.startLead("lead work");

        await waitFor(() => started.toolResults.some((text) => text.includes("cap")), "the cap error");
        const refusal = started.toolResults.find((text) => text.includes("cap")) as string;
        assert.ok(refusal.includes(String(INVOCATION_DEPTH_CAP)), refusal);
        await waitFor(async () => (await started.status()).workerThreads.inUse === 0, "every run to finish");
        assert.equal((await conversationIds(started.ctx)).length, INVOCATION_DEPTH_CAP + 1);
    });

    it("refuses an unknown role with an error naming it, creates nothing and continues the run", async () => {
        const started = await start({
            leadCalls: [{ agents: [invokedAgent("job A"), invokedAgent("job B", "nobody")], mode: "steerable" }],
        });

        const { conversationId } = await started.startLead("lead work");

        await waitFor(() => started.leadRequests.length >= 2, "the lead to continue");
        assert.match(started.toolResults.join("\n"), /nobody/);
        assert.deepEqual(await conversationIds(started.ctx), [conversationId]);
    });

    it("refuses a parked invoke that shares its model turn, creates nothing and continues the run", async () => {
        const started = await start({
            leadCalls: [
                { agents: [invokedAgent("job A")], mode: "parked" },
                { agents: [invokedAgent("job B")], mode: "parked" },
            ],
        });

        const { conversationId } = await started.startLead("lead work");

        await waitFor(() => started.leadRequests.length >= 2, "the lead to continue");
        assert.equal(started.toolResults.filter((text) => /only tool call/.test(text)).length, 2);
        assert.deepEqual(await conversationIds(started.ctx), [conversationId]);
        assert.equal((await readConversationMeta(started.ctx.host, conversationId))?.parked, null);
    });
});
