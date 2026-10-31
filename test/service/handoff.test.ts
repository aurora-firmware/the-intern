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
import { readConversationMeta, SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "cli" } };
const requestOrigin = { kind: "request", wayIn: "cli" } as const;
const SUMMARY_TEXT = "SUMMARY-OF-THE-EARLIER-WORK";

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Request = { messages: readonly Message[] };
type HandoffArguments = Record<string, unknown>;

const textOf = (message: Message | undefined): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};
const userTexts = (request: Request): string[] =>
    request.messages.filter((message) => message.role === "user").map(textOf);
// Later system messages replace the sections of the leading one by name, so the prompt in effect merges them in order.
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

type Started = {
    ctx: ServiceContext;
    requests: Request[];
    startLead(input: Record<string, unknown>): Promise<{ conversationId: string }>;
    status(): Promise<{ workerThreads: { inUse: number; waiting: { conversationId: string }[] } }>;
    entries(conversationId: string): Promise<{ kind: string; data: unknown }[]>;
    context(conversationId: string): Promise<{ kind: string; data: unknown }[]>;
};

type StartOptions = {
    /** The handoff the lead's first request makes; a request holding `holdFor` waits for `release()`. */
    handoff: HandoffArguments;
    workerThreadCount?: number;
};

async function start(options: StartOptions): Promise<Started & { release(): void }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const requests: Request[] = [];
    let release = (): void => {};
    const isHeld = new Promise<void>((resolve) => {
        release = resolve;
    });
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        const request = { messages: context.messages };
        requests.push(request);
        if (isSummarization(request)) return fauxAssistantMessage(SUMMARY_TEXT);
        const users = userTexts(request);
        const hasToolResult = request.messages.some((message) => message.role === "toolResult");
        if (users.at(-1)?.includes("first input") && !hasToolResult) {
            if (users.at(-1)?.includes("held")) await isHeld;
            return fauxAssistantMessage([fauxToolCall("handoff", options.handoff as JsonObject)], {
                stopReason: "toolUse",
            });
        }
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({
            defaultProvider: provider,
            defaultModel: "model-one",
            compaction: { keepRecentTokens: 1 },
        }),
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
    const readAll = async (conversationId: string) =>
        (await ctx.host.readEntries(conversationId, { limit: 200 })).entries;
    return {
        ctx,
        requests,
        release,
        startLead: (input) => daemon.catalogue.invoke("jobs.startLead", input, caller) as never,
        status: () => daemon.catalogue.invoke("daemon.status", {}, caller) as never,
        entries: readAll,
        context: (conversationId) => ctx.host.readContext(conversationId),
    };
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const startAndWaitForNewAgent = async (started: Started, jobId: string, firstInput = "first input") => {
    const { conversationId } = await started.startLead({ jobId, firstInput, origin: requestOrigin });
    await waitFor(
        async () => (await readConversationMeta(started.ctx.host, conversationId))?.seat.role !== "bob",
        "the seat to change",
    );
    return conversationId;
};

describe("the handoff tool", () => {
    it("runs the next turn in the same conversation with the new seat, the full context and no new input", async () => {
        const started = await start({ handoff: { role: "gp", contextMode: "full" } });

        const conversationId = await startAndWaitForNewAgent(started, "full-1");
        await waitFor(() => started.requests.length >= 2, "the new agent's request");

        const request = started.requests[1] as Request;
        assert.match(systemText(request), /You are `gp`/);
        assert.deepEqual(userTexts(request).length, 1);
        assert.match(userTexts(request)[0] ?? "", /first input/);
        const inputs = (await started.entries(conversationId)).filter((entry) => entry.kind === "pi.user");
        assert.equal(inputs.length, 1);
        const records = (await started.entries(conversationId)).filter((entry) => entry.kind === SEAT_RECORD_KIND);
        const last = records.at(-1)?.data as { actor: unknown; contextMode: string; next: { role: string } };
        assert.deepEqual(last.actor, { kind: "agent", conversationId, role: "bob" });
        assert.equal(last.contextMode, "full");
        assert.equal(last.next.role, "gp");
    });

    it("compacts the context guided by the note before the new seat's first request", async () => {
        const started = await start({ handoff: { role: "gp", contextMode: "compact", note: "KEEP-THE-PLAN" } });

        const conversationId = await startAndWaitForNewAgent(started, "compact-1");
        await waitFor(() => started.requests.some((request) => systemText(request).includes("`gp`")), "the new seat");

        const summaryIndex = started.requests.findIndex(isSummarization);
        const newSeatIndex = started.requests.findIndex((request) => systemText(request).includes("`gp`"));
        assert.ok(summaryIndex >= 0, "a summarization request was made");
        assert.ok(summaryIndex < newSeatIndex, "the compaction finished before the new seat's first request");
        assert.match(userTexts(started.requests[summaryIndex] as Request).join("\n"), /KEEP-THE-PLAN/);
        assert.ok(userTexts(started.requests[newSeatIndex] as Request).some((text) => text.includes(SUMMARY_TEXT)));
        const records = (await started.entries(conversationId)).filter((entry) => entry.kind === SEAT_RECORD_KIND);
        const last = records.at(-1)?.data as { contextMode: string; note: string };
        assert.equal(last.contextMode, "compact");
        assert.equal(last.note, "KEEP-THE-PLAN");
    });

    it("continues a clean handoff with only the note as input and keeps every earlier entry", async () => {
        const started = await start({ handoff: { role: "gp", contextMode: "clean", note: "CLEAN-NOTE" } });

        const conversationId = await startAndWaitForNewAgent(started, "clean-1");
        await waitFor(() => started.requests.length >= 2, "the new agent's request");

        const request = started.requests[1] as Request;
        assert.match(systemText(request), /You are `gp`/);
        assert.deepEqual(userTexts(request), ["CLEAN-NOTE"]);
        await waitFor(
            async () => (await started.context(conversationId)).some((e) => e.kind === "pi.assistant"),
            "answer",
        );
        const contextTexts = JSON.stringify(await started.context(conversationId));
        assert.ok(!contextTexts.includes("first input"));
        assert.ok(JSON.stringify(await started.entries(conversationId)).includes("first input"));
        const records = (await started.entries(conversationId)).filter((entry) => entry.kind === SEAT_RECORD_KIND);
        const last = records.at(-1)?.data as { contextMode: string; note: string };
        assert.equal(last.contextMode, "clean");
        assert.equal(last.note, "CLEAN-NOTE");
    });

    it("runs the clean handoff's new agent before a waiting conversation and keeps the depth", async () => {
        const started = await start({
            handoff: { role: "gp", contextMode: "clean", note: "CLEAN-NOTE" },
            workerThreadCount: 1,
        });
        const first = await started.startLead({ jobId: "a", firstInput: "first input held", origin: requestOrigin });
        await waitFor(() => started.requests.length >= 1, "the first request");
        const second = await started.startLead({ jobId: "b", firstInput: "second", origin: requestOrigin });
        await waitFor(async () => (await started.status()).workerThreads.waiting.length === 1, "the second to wait");

        started.release();
        await waitFor(() => started.requests.some((request) => userTexts(request).includes("second")), "second");

        const order = started.requests.map((request) => userTexts(request).at(-1));
        assert.ok(order.indexOf("CLEAN-NOTE") >= 0, "the new agent ran");
        assert.ok(order.indexOf("CLEAN-NOTE") < order.indexOf("second"), `the new agent ran first: ${order}`);
        assert.equal((await readConversationMeta(started.ctx.host, first.conversationId))?.depth, 0);
        assert.equal((await readConversationMeta(started.ctx.host, second.conversationId))?.seat.role, "bob");
    });

    for (const [title, handoff] of [
        ["an unknown role", { role: "nobody", contextMode: "full" }],
        ["a model that does not resolve", { role: "gp", model: "nope/none", contextMode: "full" }],
        ["a workspace that is not registered", { role: "gp", workspace: "/not/registered", contextMode: "full" }],
        ["a compact handoff without a note", { role: "gp", contextMode: "compact" }],
        ["a clean handoff without a note", { role: "gp", contextMode: "clean" }],
    ] as const) {
        it(`returns an error result and leaves the seat unchanged for ${title}`, async () => {
            const started = await start({ handoff });

            const { conversationId } = await started.startLead({
                jobId: "refused",
                firstInput: "first input",
                origin: requestOrigin,
            });
            await waitFor(() => started.requests.length >= 2, "the run to continue after the error");

            const result = started.requests[1]?.messages.find((message) => message.role === "toolResult");
            assert.equal(result?.role === "toolResult" && result.isError, true);
            assert.match(textOf(result), /The handoff was refused/);
            assert.equal((await readConversationMeta(started.ctx.host, conversationId))?.seat.role, "bob");
            const records = (await started.entries(conversationId)).filter((entry) => entry.kind === SEAT_RECORD_KIND);
            assert.equal(records.length, 1);
        });
    }
});
