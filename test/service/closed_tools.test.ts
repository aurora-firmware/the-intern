/**
 * Tools and closed conversations (S-001 REQ-026 AC-026.3, AC-026.6; REQ-020; REQ-022): a coordination or job tool
 * called from a closed conversation, or one whose job is Done, returns an error result and changes nothing, and the
 * `steer` tool and the front desk's steering tools aimed at a closed conversation return an error result. Every run
 * goes on.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { setSectionHook } from "../../src/host/job_section.ts";
import { readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import { type JobActionDeps, startJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_PAUSE_MS = 100;
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const teamMember: SeatActor = { kind: "team_member", wayIn: "command line" };
const author: JobAuthor = { kind: "team_member", wayIn: "command line" };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

function gate() {
    let open = (): void => {};
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

// A model answer that waits for the gate ends at once when its run is aborted.
function untilOpenOrAborted(opened: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        void opened.then(() => resolve());
        signal?.addEventListener("abort", () => resolve(), { once: true });
    });
}

const textOf = (message: Message | undefined): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};

type Call = { name: string; arguments: Record<string, unknown> };
type Result = { name: string; text: string; isError: boolean };
/** One model call: the text of the last input and the tool results that came after it. */
type ModelCall = { input: string; results: Result[]; signal: AbortSignal | undefined };
type Script = (call: ModelCall) => Promise<AssistantMessage | undefined> | AssistantMessage | undefined;

function modelCallOf(messages: Message[], signal: AbortSignal | undefined): ModelCall {
    const lastInput = messages.findLastIndex((message) => message.role === "user");
    const results = messages
        .slice(lastInput + 1)
        .flatMap((message) =>
            message.role === "toolResult"
                ? [{ name: message.toolName, text: textOf(message), isError: message.isError }]
                : [],
        );
    return { input: textOf(messages[lastInput]), results, signal };
}

const toolCalls = (calls: Call[]): AssistantMessage =>
    fauxAssistantMessage(
        calls.map((call) => fauxToolCall(call.name, call.arguments as JsonObject)),
        { stopReason: "toolUse" },
    );

type CreatedJob = { id: string; number: string; leadConversation: string };
type Started = Awaited<ReturnType<typeof start>>;

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let script: Script = () => undefined;
    let afterWrite: (point: WritePoint, jobId: string) => Promise<void> = async () => {};
    // Each input's tool results as the model saw them on the call after its tool round, keyed by the input's text.
    const seen = new Map<string, Result[]>();
    const answer = async (context: { messages: Message[] }, options?: { signal?: AbortSignal }) => {
        fake.appendResponses([answer]);
        const call = modelCallOf(context.messages, options?.signal);
        if (call.results.length > 0) seen.set(call.input, call.results);
        return (await script(call)) ?? fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({
        agents,
        logger: quietLogger,
        turnEndRule: false,
        afterWrite: (point, jobId) => afterWrite(point, jobId),
    });
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [
            agents.component,
            jobs.component,
            desk.component,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations],
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation, "the fake model's api is registered");
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
    await waitFor(() => daemon.phase() === "ready", "the daemon to be ready");
    const ctx = captured as ServiceContext;
    const invoke = <T = unknown>(name: string, input: unknown) =>
        daemon.catalogue.invoke(name, input, commandLine) as Promise<T>;
    const deskId = (await invoke<{ conversationId: string }>("desk.get", {})).conversationId;
    const deps: JobActionDeps = { ctx, options: jobs.options };
    const seat: Seat = agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE);
    return {
        ctx,
        deps,
        seat,
        invoke,
        deskId,
        seen,
        setScript: (next: Script) => {
            script = next;
        },
        setAfterWrite: (next: (point: WritePoint, jobId: string) => Promise<void>) => {
            afterWrite = next;
        },
    };
}

const isIdle = async (started: Started, id: string) => (await started.ctx.host.conversationInfo(id))?.busy === false;

// A job with a definition of done, started, whose lead's runs have ended.
async function startedJob(started: Started, text = "do it"): Promise<CreatedJob> {
    const job = await started.invoke<CreatedJob>("jobs.create", { text });
    await waitFor(() => isIdle(started, job.leadConversation), "the lead's first run to end");
    await started.ctx.jobStore.updateFields(job.id, { definitionOfDone: "it is done" }, author);
    await startJob(started.deps, job.id);
    await waitFor(() => isIdle(started, job.leadConversation), "the lead's runs to end");
    return job;
}

// Submits the input and returns once the run it starts has ended.
async function submitAndWait(started: Started, conversationId: string, content: string): Promise<void> {
    const { submissionId } = await started.invoke<{ submissionId: string }>("conversations.submit", {
        conversationId,
        content,
        requestId: `input:${content}`,
    });
    const waited = await started.invoke<{ state: string }>("submissions.wait", { submissionId, timeoutMs: WAIT_MS });
    assert.equal(waited.state, "done");
}

async function entryCountOf(started: Started, conversationId: string): Promise<number> {
    const conversation = await internalHarness(started.ctx.host).conversation(
        Number(conversationId) as ConversationId,
        BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
    return page?.items.length ?? 0;
}

// The results the model saw after the input's tool round: their arrival shows the run went on past the round.
async function resultsAfter(started: Started, input: string, count: number): Promise<Result[]> {
    await waitFor(() => (started.seen.get(input)?.length ?? 0) >= count, `the tool results of "${input}"`);
    return started.seen.get(input) ?? [];
}

const closedMessage = (conversationId: string) => `Conversation "${conversationId}" is closed: its job is Done.`;

describe("tools aimed at a closed conversation", () => {
    it("returns an error result for steer, send_to_conversation and stop_conversation, and the runs go on", async () => {
        const started = await start();
        const closed = await startedJob(started, "closed job");
        const target = closed.leadConversation;
        await started.invoke("jobs.cancel", { job: closed.number, justification: "not needed" });
        await waitFor(() => isIdle(started, target), "the cancelled lead's run to end");
        const open = await startedJob(started, "open job");
        started.setScript(({ input, results }) => {
            if (results.length > 0) return undefined;
            if (input === "steer the closed one") {
                return toolCalls([
                    { name: "steer", arguments: { conversationId: target, message: "hi", mode: "steer" } },
                ]);
            }
            if (input === "send and stop") {
                return toolCalls([
                    {
                        name: "send_to_conversation",
                        arguments: { conversationId: target, message: "hi", mode: "steer" },
                    },
                    { name: "stop_conversation", arguments: { conversationId: target } },
                ]);
            }
            return undefined;
        });
        const entriesBefore = await entryCountOf(started, target);

        await submitAndWait(started, open.leadConversation, "steer the closed one");
        await submitAndWait(started, started.deskId, "send and stop");

        assert.deepEqual(await resultsAfter(started, "steer the closed one", 1), [
            { name: "steer", text: `The steer was refused: ${closedMessage(target)}`, isError: true },
        ]);
        assert.deepEqual(await resultsAfter(started, "send and stop", 2), [
            {
                name: "send_to_conversation",
                text: `send_to_conversation was refused: ${closedMessage(target)}`,
                isError: true,
            },
            {
                name: "stop_conversation",
                text: `stop_conversation was refused: ${closedMessage(target)}`,
                isError: true,
            },
        ]);
        assert.equal(await entryCountOf(started, target), entriesBefore);
    });
});

// Invokes one agent from the lead; its model waits for the gate, then makes the calls. It answers "done" afterwards.
async function invokeGated(started: Started, leadId: string, prompt: string, calls: Call[], go: Promise<void>) {
    started.setScript(async ({ input, results, signal }) => {
        if (input !== prompt || results.length > 0) return undefined;
        await untilOpenOrAborted(go, signal);
        return toolCalls(calls);
    });
    const [id] = await createInvokedConversations(started.ctx.host, {
        invokingId: leadId,
        callId: `call:${prompt}`,
        agents: [{ seat: started.seat, contextMode: "clean", jobPrompt: prompt }],
        actor: teamMember,
    });
    assert.ok(id !== undefined, "an agent was invoked");
    return id;
}

const invokeArguments = (jobPrompt: string) => ({
    agents: [{ role: DEFAULT_LEAD_ROLE, contextMode: "clean", jobPrompt }],
    then: "steerable",
});

describe("coordination tools called from a conversation whose job is Done", () => {
    it("returns error results for handoff, invoke and steer, and changes no seat, creates nothing and delivers nothing", async () => {
        const started = await start();
        const job = await startedJob(started, "done job");
        const other = await startedJob(started, "other job");
        const go = gate();
        const prompt = "hand off, invoke and steer";
        const caller = await invokeGated(
            started,
            job.leadConversation,
            prompt,
            [
                { name: "handoff", arguments: { role: DEFAULT_LEAD_ROLE, contextMode: "full" } },
                { name: "invoke", arguments: invokeArguments("more work") },
                {
                    name: "steer",
                    arguments: { conversationId: other.leadConversation, message: "hi", mode: "steer" },
                },
            ],
            go.opened,
        );
        const seatBefore = (await readConversationMeta(started.ctx.host, caller))?.seat;
        const conversationsBefore = (await started.ctx.host.listConversations()).length;
        const steeredBefore = await entryCountOf(started, other.leadConversation);
        let results: Result[] = [];
        started.setAfterWrite(async (point, jobId) => {
            if (point !== "job-completed" || jobId !== job.id) return;
            go.open();
            results = await resultsAfter(started, prompt, 3);
        });

        await started.invoke("jobs.complete", { job: job.number, justification: "checked by hand" });

        assert.deepEqual(results, [
            { name: "handoff", text: `The handoff was refused: ${closedMessage(caller)}`, isError: true },
            {
                name: "invoke",
                text: `The invocation was refused: ${closedMessage(caller)} Nothing was created.`,
                isError: true,
            },
            { name: "steer", text: `The steer was refused: ${closedMessage(caller)}`, isError: true },
        ]);
        assert.deepEqual((await readConversationMeta(started.ctx.host, caller))?.seat, seatBefore);
        assert.equal((await started.ctx.host.listConversations()).length, conversationsBefore);
        assert.equal(await entryCountOf(started, other.leadConversation), steeredBefore);
    });
});
