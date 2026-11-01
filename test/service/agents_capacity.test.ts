import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type AssistantMessage,
    type FauxProviderRegistration,
    fauxAssistantMessage,
    fauxToolCall,
    type JsonObject,
    type Message,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { continueParked, parkConversation } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const WAITING_STATUS = "waiting for a worker thread";
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

type ModelCall = { first: string; nth: number; messages: Message[] };
type Script = (call: ModelCall) => Promise<AssistantMessage | undefined> | AssistantMessage | undefined;

const usersOf = (messages: Message[]): string[] => messages.filter((m) => m.role === "user").map(textOf);

async function start(script: Script) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const calls: ModelCall[] = [];
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        const first = usersOf(context.messages)[0] ?? "";
        const nth = calls.filter((call) => call.first === first).length;
        const call: ModelCall = { first, nth, messages: context.messages };
        calls.push(call);
        return (await script(call)) ?? fauxAssistantMessage("done");
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
        workerThreadCount: 1,
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
        callsOf: (first: string) => calls.filter((call) => call.first === first),
        order: () => calls.map((call) => call.first),
        startLead: async (firstInput: string, jobId: string) =>
            (
                (await daemon.catalogue.invoke(
                    "jobs.startLead",
                    { jobId, firstInput, origin: requestOrigin },
                    caller,
                )) as { conversationId: string }
            ).conversationId,
        statusOf: async (conversationId: string) =>
            (
                (await daemon.catalogue.invoke("conversations.get", { conversationId }, caller)) as {
                    status: string;
                }
            ).status,
        workerThreads: async () =>
            (
                (await daemon.catalogue.invoke("daemon.status", {}, caller)) as {
                    workerThreads: { inUse: number; waiting: { conversationId: string; position: number }[] };
                }
            ).workerThreads,
    };
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function gate() {
    let release = (): void => {};
    const opened = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { opened, release };
}

// The tool's parameter is named `then`; one place builds it so the lint exception stays single.
const parkedInvokeCall = (jobPrompt: string): AssistantMessage =>
    fauxAssistantMessage(
        [
            fauxToolCall("invoke", {
                agents: [{ role: "gp", contextMode: "clean", jobPrompt }],
                // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
                then: "parked",
            } as JsonObject),
        ],
        { stopReason: "toolUse" },
    );

describe("agent runs against the worker-thread cap", () => {
    it("runs a parked agent's invoked agent with one worker thread and then continues the parked agent", async () => {
        const started = await start((call) => {
            if (call.first === "lead work" && call.nth === 0) return parkedInvokeCall("invoked work");
            if (call.first === "invoked work") return fauxAssistantMessage("the invoked report");
            return undefined;
        });

        const leadId = await started.startLead("lead work", "job-1");

        await waitFor(() => started.callsOf("lead work").length === 2, "the parked lead to continue");
        assert.deepEqual(started.order(), ["lead work", "invoked work", "lead work"]);
        assert.ok(
            usersOf((started.callsOf("lead work")[1] as ModelCall).messages).includes("the invoked report"),
            "the continued lead received the invoked agent's report",
        );
        assert.equal((await readConversationMeta(started.ctx.host, leadId))?.parked, null);
    });

    it("starts waiting runs in arrival order and reports each as waiting until it starts", async () => {
        const holder = gate();
        const started = await start(async (call) => {
            if (call.first === "first work") await holder.opened;
            return undefined;
        });
        const firstId = await started.startLead("first work", "job-a");
        await waitFor(() => started.callsOf("first work").length === 1, "the first run to hold the worker thread");
        const secondId = await started.startLead("second work", "job-b");
        const thirdId = await started.startLead("third work", "job-c");

        await waitFor(async () => (await started.workerThreads()).waiting.length === 2, "two runs to wait");
        assert.deepEqual((await started.workerThreads()).waiting, [
            { conversationId: secondId, position: 1 },
            { conversationId: thirdId, position: 2 },
        ]);
        assert.equal(await started.statusOf(firstId), "running");
        assert.equal(await started.statusOf(secondId), WAITING_STATUS);
        assert.equal(await started.statusOf(thirdId), WAITING_STATUS);
        assert.deepEqual(started.order(), ["first work"], "no waiting run started while the thread was in use");

        holder.release();

        await waitFor(() => started.order().length === 3, "both waiting runs to start");
        assert.deepEqual(started.order(), ["first work", "second work", "third work"]);
        await waitFor(async () => (await started.workerThreads()).inUse === 0, "every run to finish");
    });
});

describe("a job's lead conversation parked for an answer", () => {
    const parkedForAnswer = { waitingFor: "answer", continueOn: "each" } as const;

    it("holds no worker thread and lets another conversation's run take it", async () => {
        const holder = gate();
        const started = await start(async (call) => {
            if (call.first === "other work") await holder.opened;
            return undefined;
        });
        const leadId = await started.startLead("lead work", "job-1");
        await waitFor(
            async () => started.callsOf("lead work").length === 1 && (await started.workerThreads()).inUse === 0,
            "the lead run to end",
        );

        await parkConversation(started.ctx.host, leadId, parkedForAnswer);

        assert.equal((await started.workerThreads()).inUse, 0, "the parked lead holds no worker thread");
        const otherId = await started.startLead("other work", "job-2");
        await waitFor(() => started.callsOf("other work").length === 1, "the other run to start");
        assert.equal((await started.workerThreads()).inUse, 1);
        assert.equal(await started.statusOf(otherId), "running");
        assert.equal(await started.statusOf(leadId), "parked");
        holder.release();
        await waitFor(async () => (await started.workerThreads()).inUse === 0, "the other run to finish");
    });

    it("continues once a worker thread is free when the answer arrives through continueParked", async () => {
        const holder = gate();
        const started = await start(async (call) => {
            if (call.first === "other work") await holder.opened;
            return undefined;
        });
        const leadId = await started.startLead("lead work", "job-1");
        await waitFor(
            async () => started.callsOf("lead work").length === 1 && (await started.workerThreads()).inUse === 0,
            "the lead run to end",
        );
        await parkConversation(started.ctx.host, leadId, parkedForAnswer);
        await started.startLead("other work", "job-2");
        await waitFor(() => started.callsOf("other work").length === 1, "the other run to hold the worker thread");

        await continueParked(started.ctx.host, leadId, { content: "the answer", requestId: "answer-1" });

        assert.equal((await readConversationMeta(started.ctx.host, leadId))?.parked, null);
        await waitFor(
            async () => (await started.statusOf(leadId)) === WAITING_STATUS,
            "the lead to wait for the thread",
        );
        assert.equal(started.callsOf("lead work").length, 1, "the lead did not run while the thread was in use");

        holder.release();

        await waitFor(() => started.callsOf("lead work").length === 2, "the lead to continue");
        assert.ok(usersOf((started.callsOf("lead work")[1] as ModelCall).messages).includes("the answer"));
        await waitFor(async () => (await started.workerThreads()).inUse === 0, "every run to finish");
    });
});
