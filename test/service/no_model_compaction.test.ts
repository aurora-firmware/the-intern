/**
 * Compaction, handoffs and invocations with no model (ADR-014 decision 3; S-001 REQ-006, REQ-008, REQ-027): a
 * compaction asked for in a conversation whose seat has no model creates no compaction task and is kept in the
 * `waitingForModel` fact, to run before the conversation's next run once pi agent's folder names a default model. The
 * tests run the daemon in this process on a fake model and rewrite `settings.json` in its isolated pi agent folder.
 */
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
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { NOTICE_KIND } from "../../src/host/model_wait.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 10;
const SUMMARY_TEXT = "SUMMARY-OF-THE-EARLIER-WORK";
const NOTE = "KEEP-THE-PLAN";
const FIRST_INPUT = "first input";
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Request = { messages: readonly Message[] };

const textOf = (message: Message | undefined): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};
const userTexts = (request: Request): string[] =>
    request.messages.filter((message) => message.role === "user").map(textOf);
const systemText = (request: Request): string => {
    const sections: Record<string, string | null> = {};
    let base = "";
    for (const message of request.messages) {
        if (message.role !== "system") continue;
        base += textOf(message);
        Object.assign(sections, message.sections);
    }
    return [base, ...Object.values(sections)].join("\n");
};
const isSummarization = (request: Request): boolean => systemText(request).includes("context summarization assistant");

type Rig = {
    ctx: ServiceContext;
    requests: Request[];
    invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
    createLead(role: string): Promise<string>;
    kinds(conversationId: string): Promise<string[]>;
    setDefaultModel(): Promise<void>;
    waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void>;
};

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

// The folder names no default model. `worker` names the fake model itself and `idle` names none; the lead's first
// request makes `leadCall` when there is one, and every other request is answered with text.
async function start(options: { leadCall?: { name: string; args: JsonObject }; workerThreadCount?: number }) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const requests: Request[] = [];
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        const request = { messages: context.messages };
        requests.push(request);
        if (isSummarization(request)) return fauxAssistantMessage(SUMMARY_TEXT);
        const hasToolResult = request.messages.some((message) => message.role === "toolResult");
        if (options.leadCall !== undefined && userTexts(request).at(-1)?.includes(FIRST_INPUT) && !hasToolResult) {
            const { name, args } = options.leadCall;
            return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    const settingsFile = join(env.piAgentDir, "settings.json");
    await writeFile(settingsFile, JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
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
        components: [agents.component, jobs.component, probe],
        operations: [...agents.operations, ...jobs.operations],
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
    await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
    const ctx = captured as ServiceContext;
    const invoke = (name: string, args: Record<string, unknown>) => daemon.catalogue.invoke(name, args, caller);
    await invoke("roles.create", { name: "worker", instructions: "Work.", model: `${provider}/model-one` });
    await invoke("roles.create", { name: "idle", instructions: "Wait." });
    const rig: Rig = {
        ctx,
        requests,
        invoke,
        waitFor,
        createLead: async (role) =>
            ((await invoke("jobs.create", { text: FIRST_INPUT, role })) as { leadConversation: string })
                .leadConversation,
        kinds: async (conversationId) =>
            (await ctx.host.readEntries(conversationId, { limit: 200 })).entries.map((entry) => entry.kind),
        setDefaultModel: () =>
            writeFile(
                settingsFile,
                JSON.stringify({
                    defaultProvider: provider,
                    defaultModel: "model-one",
                    compaction: { keepRecentTokens: 1 },
                }),
            ),
    };
    return rig;
}

const waitingOf = async (rig: Rig, conversationId: string) =>
    (await readConversationMeta(rig.ctx.host, conversationId))?.waitingForModel;

describe("a compaction with no model", () => {
    it("is accepted, creates no compaction task and runs before the conversation's next run once a model appears", async () => {
        const rig = await start({});
        const lead = await rig.createLead("idle");
        await rig.waitFor(async () => (await waitingOf(rig, lead)) !== undefined, "the lead to wait for a model");

        await rig.invoke("conversations.compact", { conversationId: lead, instructions: NOTE });

        assert.deepEqual((await waitingOf(rig, lead))?.compaction, { instructions: NOTE });
        assert.equal(rig.requests.length, 0);
        assert.equal((await rig.kinds(lead)).includes("pi.compaction"), false);
        assert.equal((await rig.kinds(lead)).filter((kind) => kind === NOTICE_KIND).length, 1);

        await rig.setDefaultModel();
        await rig.waitFor(async () => (await rig.kinds(lead)).includes("pi.assistant"), "the lead's answer");

        const summaryIndex = rig.requests.findIndex(isSummarization);
        assert.ok(summaryIndex >= 0, "the compaction ran");
        assert.equal(summaryIndex, 0);
        assert.match(userTexts(rig.requests[summaryIndex] as Request).join("\n"), new RegExp(NOTE));
        assert.equal(await waitingOf(rig, lead), undefined);
    });

    it("adds its instructions to a fact that is already set", async () => {
        const rig = await start({});
        const lead = await rig.createLead("idle");
        await rig.waitFor(async () => (await waitingOf(rig, lead)) !== undefined, "the lead to wait for a model");
        const before = await waitingOf(rig, lead);

        await rig.invoke("conversations.compact", { conversationId: lead, instructions: NOTE });

        assert.deepEqual(await waitingOf(rig, lead), { order: before?.order, compaction: { instructions: NOTE } });
        assert.equal((await rig.kinds(lead)).filter((kind) => kind === NOTICE_KIND).length, 1);
    });
});

describe("a handoff to a role with no model", () => {
    it("with the Compact mode reports success, waits, and compacts with the note before the new agent runs", async () => {
        const rig = await start({
            leadCall: { name: "handoff", args: { role: "idle", contextMode: "compact", note: NOTE } },
        });
        const lead = await rig.createLead("worker");
        await rig.waitFor(async () => (await waitingOf(rig, lead)) !== undefined, "the lead to wait for a model");

        assert.deepEqual((await waitingOf(rig, lead))?.compaction, { instructions: NOTE });
        assert.equal(rig.requests.some(isSummarization), false);
        const result = JSON.stringify(
            (await rig.ctx.host.readContext(lead)).filter((entry) => entry.kind.includes("tool")),
        );
        assert.match(result, /now handled by a new idle agent/);
        assert.doesNotMatch(result, /did not finish/);

        await rig.setDefaultModel();
        await rig.waitFor(
            async () => (await rig.kinds(lead)).filter((k) => k === "pi.assistant").length >= 2,
            "the new agent",
        );

        const summaryIndex = rig.requests.findIndex(isSummarization);
        const newAgentIndex = rig.requests.findIndex((request) => systemText(request).includes("`idle`"));
        assert.ok(summaryIndex >= 0 && summaryIndex < newAgentIndex, "the compaction came first");
        assert.match(userTexts(rig.requests[summaryIndex] as Request).join("\n"), new RegExp(NOTE));
    });

    it("with the Full mode gives the worker thread back and waits with one notice", async () => {
        const rig = await start({
            leadCall: { name: "handoff", args: { role: "idle", contextMode: "full" } },
            workerThreadCount: 1,
        });
        const lead = await rig.createLead("worker");

        await rig.waitFor(async () => (await waitingOf(rig, lead)) !== undefined, "the lead to wait for a model");

        const status = (await rig.invoke("daemon.status", {})) as { workerThreads: { inUse: number } };
        assert.equal(status.workerThreads.inUse, 0);
        assert.equal((await rig.kinds(lead)).filter((kind) => kind === NOTICE_KIND).length, 1);
        assert.equal((await waitingOf(rig, lead))?.compaction, undefined);
    });
});

describe("an invocation of an agent whose role has no model", () => {
    it("creates the invoked conversation with its job prompt waiting while the invoker stays parked", async () => {
        const rig = await start({
            leadCall: {
                name: "invoke",
                args: {
                    agents: [{ role: "idle", contextMode: "compact", jobPrompt: "invoked work" }],
                    // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
                    then: "parked",
                },
            },
        });
        const lead = await rig.createLead("worker");
        await rig.waitFor(
            async () => (await readConversationMeta(rig.ctx.host, lead))?.awaiting.length === 1,
            "the park",
        );
        const [invokedId] = (await readConversationMeta(rig.ctx.host, lead))?.awaiting ?? [];
        assert.ok(invokedId !== undefined);
        await rig.waitFor(async () => (await waitingOf(rig, invokedId)) !== undefined, "the invoked agent to wait");

        assert.equal((await readConversationMeta(rig.ctx.host, lead))?.awaiting.length, 1);
        assert.deepEqual((await waitingOf(rig, invokedId))?.compaction, { instructions: "invoked work" });
        assert.equal((await rig.kinds(invokedId)).filter((kind) => kind === NOTICE_KIND).length, 1);

        await rig.setDefaultModel();
        await rig.waitFor(
            async () => (await readConversationMeta(rig.ctx.host, lead))?.awaiting.length === 0,
            "the report to arrive",
        );
        assert.ok((await rig.kinds(lead)).includes("pi.assistant"));
        const summaryIndex = rig.requests.findIndex(isSummarization);
        const invokedIndex = rig.requests.findIndex((request) => userTexts(request).at(-1) === "invoked work");
        assert.ok(summaryIndex >= 0 && summaryIndex < invokedIndex, "the compaction came before the job prompt");
    });
});
