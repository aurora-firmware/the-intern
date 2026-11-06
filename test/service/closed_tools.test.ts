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
import { type ConversationId, InboxDoc, type SubmissionId } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { setJobStatusCheck, setSectionHook } from "../../src/host/job_section.ts";
import { readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import { type JobActionDeps, startJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor, JobStatus } from "../../src/jobs/job_model.ts";
import { JobNotFoundError } from "../../src/jobs/job_store.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_PAUSE_MS = 100;
const SUBMISSION_ID_PROBE_LIMIT = 200;
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
    // A model call follows the first script that answers it; with none it answers "done".
    const scripts: Script[] = [];
    let afterWrite: (point: WritePoint, jobId: string) => Promise<void> = async () => {};
    // Each input's tool results as the model saw them on the call after its tool round, keyed by the input's text.
    const seen = new Map<string, Result[]>();
    const answer = async (context: { messages: Message[] }, options?: { signal?: AbortSignal }) => {
        fake.appendResponses([answer]);
        const call = modelCallOf(context.messages, options?.signal);
        if (call.results.length > 0) seen.set(call.input, call.results);
        for (const script of scripts) {
            const reply = await script(call);
            if (reply !== undefined) return reply;
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
        addScript: (script: Script) => {
            scripts.push(script);
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
        started.addScript(({ input, results }) => {
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
    started.addScript(async ({ input, results, signal }) => {
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
    // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
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

describe("job tools called from a closed conversation", () => {
    it("returns error results naming the conversation as closed, and changes no job", async () => {
        const started = await start();
        const job = await startedJob(started, "closing job");
        const go = gate();
        const prompt = "write to the job";
        const caller = await invokeGated(
            started,
            job.leadConversation,
            prompt,
            [
                { name: "add_worklog", arguments: { text: "a late note" } },
                { name: "create_job", arguments: { text: "a late follow-up", related: true } },
            ],
            go.opened,
        );
        const worklogBefore = (await started.ctx.jobStore.listWorklog(job.id, {})).entries.length;
        const jobsBefore = (await started.ctx.jobStore.listJobs({})).jobs.length;
        let results: Result[] = [];
        started.setAfterWrite(async (point, jobId) => {
            if (point !== "conversations-closed" || jobId !== job.id) return;
            go.open();
            results = await resultsAfter(started, prompt, 2);
        });

        await started.invoke("jobs.complete", { job: job.number, justification: "checked by hand" });

        assert.deepEqual(results, [
            { name: "add_worklog", text: `add_worklog was refused: ${closedMessage(caller)}`, isError: true },
            { name: "create_job", text: `create_job was refused: ${closedMessage(caller)}`, isError: true },
        ]);
        assert.equal((await started.ctx.jobStore.listWorklog(job.id, {})).entries.length, worklogBefore);
        assert.equal((await started.ctx.jobStore.listJobs({})).jobs.length, jobsBefore);
    });
});

async function conversationsOfJob(started: Started, jobId: string): Promise<string[]> {
    const ofJob: string[] = [];
    for (const { id } of await started.ctx.host.listConversations()) {
        if ((await readConversationMeta(started.ctx.host, id))?.jobId === jobId) ofJob.push(id);
    }
    return ofJob;
}

async function closedMarksOf(started: Started, ids: string[]): Promise<(boolean | undefined)[]> {
    const marks: (boolean | undefined)[] = [];
    for (const id of ids) marks.push((await readConversationMeta(started.ctx.host, id))?.closed);
    return marks;
}

const COMPLETE_INPUT = "complete now";

// The lead's model calls `complete_job` on the input once `ready` settles.
function leadCompletesWhen(started: Started, ready: Promise<void>): void {
    started.addScript(async ({ input, results, signal }) => {
        if (input !== COMPLETE_INPUT || results.length > 0) return undefined;
        await untilOpenOrAborted(ready, signal);
        return toolCalls([{ name: "complete_job", arguments: { justification: "checked" } }]);
    });
}

async function submitCompleteInput(started: Started, leadId: string): Promise<void> {
    await started.invoke("conversations.submit", {
        conversationId: leadId,
        content: COMPLETE_INPUT,
        requestId: "complete-now",
    });
}

describe("an invoke in flight as the lead calls complete_job", () => {
    it("closes the conversation it creates with the others when its check passed first", async () => {
        const started = await start();
        const job = await startedJob(started, "racing job");
        const go = gate();
        const reached = gate();
        const release = gate();
        const prompt = "invoke one more";
        const caller = await invokeGated(
            started,
            job.leadConversation,
            prompt,
            [{ name: "invoke", arguments: invokeArguments("grandchild work") }],
            go.opened,
        );
        leadCompletesWhen(started, reached.opened);
        setSectionHook(started.ctx.host, async (conversationId) => {
            if (conversationId !== caller) return;
            reached.open();
            await release.opened;
        });
        let results: Result[] = [];
        started.setAfterWrite(async (point, jobId) => {
            if (point === "conversations-closed" && jobId === job.id) results = await resultsAfter(started, prompt, 1);
        });

        await submitCompleteInput(started, job.leadConversation);
        go.open();
        await waitFor(async () => (await started.ctx.jobStore.getJob(job.id)).status === "done", "the job to be Done");
        await sleep(SETTLE_PAUSE_MS);
        release.open();
        await waitFor(() => results.length > 0, "the invoke's result");

        const ofJob = await conversationsOfJob(started, job.id);
        const created = ofJob.find((id) => id !== job.leadConversation && id !== caller) as string;
        assert.equal(ofJob.length, 3);
        assert.deepEqual(await closedMarksOf(started, ofJob), [true, true, true]);
        assert.deepEqual(results, [
            { name: "invoke", text: `The invocation was refused: ${closedMessage(created)}`, isError: true },
        ]);
    });

    it("creates no conversation when the job closed before its check", async () => {
        const started = await start();
        const job = await startedJob(started, "racing job");
        const go = gate();
        const prompt = "invoke one more";
        const caller = await invokeGated(
            started,
            job.leadConversation,
            prompt,
            [{ name: "invoke", arguments: invokeArguments("grandchild work") }],
            go.opened,
        );
        leadCompletesWhen(started, Promise.resolve());
        const passedChecks: string[] = [];
        setSectionHook(started.ctx.host, (conversationId) => {
            if (conversationId === caller) passedChecks.push(conversationId);
        });
        let results: Result[] = [];
        started.setAfterWrite(async (point, jobId) => {
            if (point !== "conversations-closed" || jobId !== job.id) return;
            go.open();
            results = await resultsAfter(started, prompt, 1);
        });

        await submitCompleteInput(started, job.leadConversation);
        await waitFor(() => results.length > 0, "the invoke's result");

        const ofJob = await conversationsOfJob(started, job.id);
        assert.deepEqual(ofJob.sort(), [job.leadConversation, caller].sort());
        assert.deepEqual(await closedMarksOf(started, ofJob), [true, true]);
        assert.deepEqual(passedChecks, []);
        assert.deepEqual(results, [
            {
                name: "invoke",
                text: `The invocation was refused: ${closedMessage(caller)} Nothing was created.`,
                isError: true,
            },
        ]);
    });
});

describe("a handoff in flight as the lead calls complete_job", () => {
    it("commits its seat change before the conversation closes when its check passed first", async () => {
        const started = await start();
        const job = await startedJob(started, "racing job");
        const go = gate();
        const reached = gate();
        const release = gate();
        const prompt = "hand off";
        const caller = await invokeGated(
            started,
            job.leadConversation,
            prompt,
            [{ name: "handoff", arguments: { role: "gp", contextMode: "full" } }],
            go.opened,
        );
        leadCompletesWhen(started, reached.opened);
        setSectionHook(started.ctx.host, async (conversationId) => {
            if (conversationId !== caller) return;
            reached.open();
            await release.opened;
        });
        let results: Result[] = [];
        started.setAfterWrite(async (point, jobId) => {
            if (point === "conversations-closed" && jobId === job.id) results = await resultsAfter(started, prompt, 1);
        });

        await submitCompleteInput(started, job.leadConversation);
        go.open();
        await waitFor(async () => (await started.ctx.jobStore.getJob(job.id)).status === "done", "the job to be Done");
        await sleep(SETTLE_PAUSE_MS);
        release.open();
        await waitFor(() => results.length > 0, "the handoff's result");

        const meta = await readConversationMeta(started.ctx.host, caller);
        assert.deepEqual([meta?.seat.role, meta?.closed], ["gp", true]);
        assert.deepEqual(results, [
            { name: "handoff", text: "This conversation is now handled by a new gp agent.", isError: false },
        ]);
    });
});

describe("the tools called from and aimed at open conversations", () => {
    it("act as before: coordination and job tools from an agent, steering tools from the front desk", async () => {
        const started = await start();
        const job = await startedJob(started, "open job");
        const lead = job.leadConversation;
        const prompt = "use every tool";
        const caller = await invokeGated(
            started,
            lead,
            prompt,
            [
                { name: "handoff", arguments: { role: "gp", contextMode: "full" } },
                { name: "invoke", arguments: invokeArguments("more work") },
                { name: "steer", arguments: { conversationId: lead, message: "hi", mode: "followUp" } },
                { name: "add_worklog", arguments: { text: "a note" } },
            ],
            Promise.resolve(),
        );
        const results = await resultsAfter(started, prompt, 4);
        await waitFor(async () => (await conversationsOfJob(started, job.id)).length === 3, "the invoked agent");
        await waitFor(
            async () => (await readConversationMeta(started.ctx.host, caller))?.awaiting.length === 0,
            "the invoked agent's report",
        );
        started.addScript(({ input, results: seen }) => {
            if (input !== "send and stop" || seen.length > 0) return undefined;
            return toolCalls([
                { name: "send_to_conversation", arguments: { conversationId: lead, message: "hi", mode: "followUp" } },
                { name: "stop_conversation", arguments: { conversationId: caller } },
            ]);
        });
        await submitAndWait(started, started.deskId, "send and stop");

        assert.deepEqual(
            results.map(({ name, isError }) => [name, isError]),
            [
                ["handoff", false],
                ["invoke", false],
                ["steer", false],
                ["add_worklog", false],
            ],
        );
        assert.match(results[1]?.text ?? "", /^Invoked conversations: \d+\.$/);
        assert.equal((await readConversationMeta(started.ctx.host, caller))?.seat.role, "gp");
        assert.deepEqual(
            (await started.ctx.jobStore.listWorklog(job.id, {})).entries.map((entry) => entry.text),
            ["a note"],
        );
        assert.deepEqual(await resultsAfter(started, "send and stop", 2), [
            { name: "send_to_conversation", text: `The message was sent to conversation ${lead}.`, isError: false },
            { name: "stop_conversation", text: `Stopped conversations: ${caller}.`, isError: false },
        ]);
    });
});

async function statusInStore(started: Started, jobId: string): Promise<JobStatus | undefined> {
    try {
        return (await started.ctx.jobStore.getJob(jobId)).status;
    } catch (error) {
        if (error instanceof JobNotFoundError) return undefined;
        throw error;
    }
}

// Replaces the job Done check. Once armed, the next check of the job reads the job, then waits for `completed` and
// answers what it read: the job's complete falls between a tool's own closed check and the check in the job's section.
function staleNextCheck(started: Started, jobId: string, completed: Promise<void>) {
    const checked = gate();
    let isArmed = false;
    setJobStatusCheck(started.ctx.host, async (checkedJobId) => {
        const status = await statusInStore(started, checkedJobId);
        if (!isArmed || checkedJobId !== jobId) return status;
        isArmed = false;
        checked.open();
        await completed;
        return status;
    });
    return {
        checked: checked.opened,
        arm: () => {
            isArmed = true;
        },
    };
}

// The caller's model makes the call once the stale check is armed; the job completes while that check waits.
async function completeBetweenTheChecks(started: Started, job: CreatedJob, prompt: string, call: Call) {
    const go = gate();
    const caller = await invokeGated(started, job.leadConversation, prompt, [call], go.opened);
    const completed = gate();
    const stale = staleNextCheck(started, job.id, completed.opened);
    let results: Result[] = [];
    started.setAfterWrite(async (point, jobId) => {
        if (jobId !== job.id) return;
        if (point === "job-completed") completed.open();
        if (point === "conversations-closed") results = await resultsAfter(started, prompt, 1);
    });
    stale.arm();
    go.open();
    await stale.checked;
    await started.invoke("jobs.complete", { job: job.number, justification: "checked by hand" });
    return { caller, results };
}

describe("a tool whose own check passed before the job completed", () => {
    it("returns an error result for invoke refused by the check in the job's section, and creates nothing", async () => {
        const started = await start();
        const job = await startedJob(started, "racing job");

        const { caller, results } = await completeBetweenTheChecks(started, job, "invoke late", {
            name: "invoke",
            arguments: invokeArguments("grandchild work"),
        });

        assert.deepEqual((await conversationsOfJob(started, job.id)).sort(), [job.leadConversation, caller].sort());
        assert.deepEqual(results, [
            {
                name: "invoke",
                text: `The invocation was refused: ${closedMessage(caller)} Nothing was created.`,
                isError: true,
            },
        ]);
    });

    it("returns an error result for handoff refused by the check in the job's section, and changes no seat", async () => {
        const started = await start();
        const job = await startedJob(started, "racing job");

        const { caller, results } = await completeBetweenTheChecks(started, job, "hand off late", {
            name: "handoff",
            arguments: { role: "gp", contextMode: "full" },
        });

        assert.equal((await readConversationMeta(started.ctx.host, caller))?.seat.role, DEFAULT_LEAD_ROLE);
        assert.deepEqual(results, [
            { name: "handoff", text: `The handoff was refused: ${closedMessage(caller)}`, isError: true },
        ]);
    });
});

type InboxItem = { id: number; mode: string };

async function inboxOf(started: Started, conversationId: string): Promise<InboxItem[]> {
    return internalHarness(started.ctx.host).commit(async (tx) => {
        const { items } = await tx.doc(InboxDoc, Number(conversationId) as ConversationId);
        return JSON.parse(JSON.stringify(items)) as InboxItem[];
    }, BACKGROUND_CONTEXT);
}

// The harness reads one submission by id and ids are not contiguous, so the ones closed are found by probing a range.
async function closedOf(started: Started, conversationId: string) {
    const harness = internalHarness(started.ctx.host);
    const settled: { type: string; reason: string }[] = [];
    for (let id = 1; id <= SUBMISSION_ID_PROBE_LIMIT; id += 1) {
        const submission = await harness.submission(id as SubmissionId, BACKGROUND_CONTEXT);
        if (submission === undefined) continue;
        const record = await submission.status(BACKGROUND_CONTEXT);
        if (
            String(record.conversationId) === conversationId &&
            record.status === "unanswered" &&
            record.reason === "closed"
        ) {
            settled.push({ type: record.type, reason: record.reason });
        }
    }
    return settled;
}

async function resetCount(started: Started, conversationId: string): Promise<number> {
    const { entries } = await started.invoke<Promise<{ entries: { kind: string }[] }>>("conversations.entries", {
        conversationId,
        limit: 500,
    });
    return entries.filter((entry) => entry.kind === "pi.reset").length;
}

describe("a clean handoff committed just before the job closes", () => {
    it("settles its queued note unanswered by the job's abort, and the note runs no model turn", async () => {
        const started = await start();
        const job = await startedJob(started, "racing job");
        const go = gate();
        const reached = gate();
        const release = gate();
        const note = "carry on from the note";
        const noteTurns: string[] = [];
        started.addScript(({ input }) => {
            if (input === note) noteTurns.push(input);
            return undefined;
        });
        const caller = await invokeGated(
            started,
            job.leadConversation,
            "hand off clean",
            [{ name: "handoff", arguments: { role: "gp", contextMode: "clean", note } }],
            go.opened,
        );
        leadCompletesWhen(started, reached.opened);
        setSectionHook(started.ctx.host, async (conversationId) => {
            if (conversationId !== caller) return;
            reached.open();
            await release.opened;
        });

        const resetsBefore = await resetCount(started, caller);
        await submitCompleteInput(started, job.leadConversation);
        go.open();
        await waitFor(async () => (await started.ctx.jobStore.getJob(job.id)).status === "done", "the job to be Done");
        await sleep(SETTLE_PAUSE_MS);
        release.open();
        await waitFor(async () => (await closedOf(started, caller)).length === 2, "the queued items to be closed");

        assert.deepEqual(
            (await closedOf(started, caller)).map(({ type, reason }) => [type, reason]),
            [
                ["write", "closed"],
                ["input", "closed"],
            ],
        );
        assert.deepEqual(await inboxOf(started, caller), []);
        assert.equal(await resetCount(started, caller), resetsBefore, "no reset is placed after the closed mark");
        assert.equal((await readConversationMeta(started.ctx.host, caller))?.closed, true);
        assert.deepEqual(noteTurns, []);
    });
});
