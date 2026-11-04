import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { conversationEntryLine } from "../../src/cli/feed_text.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submissionIdFor, submitInput } from "../../src/host/conversation_control.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { createJobsComponent, type JobsComponentOptions } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const emailCaller: Caller = { actor: { kind: "team_member", wayIn: "email" } };
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Call = { name: string; arguments: Record<string, unknown> };
/** One model reply of a scripted conversation: tool calls of one round, or a hold that ends in a plain reply. */
type Step = { calls: Call[]; before?: () => Promise<void> } | { hold: Promise<unknown>; onEntered?: () => void };
type ModelContext = Parameters<FauxResponseFactory>[0];
type ToolResultSeen = { text: string; isError: boolean };
type CreatedJob = { id: string; number: string; leadConversation: string };

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

const toolResultsOf = (context: ModelContext): ToolResultSeen[] =>
    context.messages.flatMap((message) =>
        message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
    );

const call = (name: string, args: Record<string, unknown>): Step => ({ calls: [{ name, arguments: args }] });

function deferred() {
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/**
 * A daemon whose conversations follow scripts. A conversation follows the script whose key its first user message
 * contains, one step per model reply; any other conversation answers "done".
 */
async function start(
    scripts: Record<string, Step[]>,
    workerThreadCount?: number,
    afterWrite?: NonNullable<JobsComponentOptions["afterWrite"]>,
    sameEnvAs?: HermeticEnv,
) {
    const logLines: string[] = [];
    const quietLogger = createLogger({
        stream: {
            write: (line) => {
                logLines.push(String(line));
                return true;
            },
        },
    });
    const env = sameEnvAs ?? (await createHermeticEnv());
    if (sameEnvAs === undefined) envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const results: Record<string, ToolResultSeen[]> = {};
    const replies: Record<string, number> = {};
    const respond: FauxResponseFactory = async (context, streamOptions) => {
        fake.appendResponses([respond]);
        const first = context.messages.find((message) => message.role === "user");
        const text = first === undefined ? "" : textOf(first.content);
        const key = Object.keys(scripts).find((candidate) => text.includes(candidate));
        if (key === undefined) return fauxAssistantMessage("done");
        results[key] = toolResultsOf(context);
        replies[key] = (replies[key] ?? 0) + 1;
        const step = (scripts[key] as Step[])[context.messages.filter((m) => m.role === "assistant").length];
        if (step === undefined) return fauxAssistantMessage("finished");
        if ("hold" in step) {
            step.onEntered?.();
            // An abort ends the held request, as it ends a real one.
            const signal = streamOptions?.signal;
            const isAborted = new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                signal?.addEventListener("abort", () => resolve());
            });
            await Promise.race([step.hold, isAborted]);
            return fauxAssistantMessage("done");
        }
        await step.before?.();
        return fauxAssistantMessage(
            step.calls.map((c) => fauxToolCall(c.name, c.arguments as never)),
            { stopReason: "toolUse" },
        );
    };
    fake.setResponses([respond]);
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
        ...(afterWrite !== undefined && { afterWrite }),
    });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        checkModels: async (ctx) => {
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
        ...(workerThreadCount !== undefined && { workerThreadCount }),
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
    return {
        ctx,
        env,
        daemon,
        logLines,
        invoke: (name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller),
        results,
        replies,
        createJob: async (text: string, as: Caller = webCaller): Promise<CreatedJob> =>
            (await daemon.catalogue.invoke("jobs.create", { text }, as)) as CreatedJob,
        isIdle: async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false,
        status: async (jobId: string) => (await ctx.jobStore.getJob(jobId)).status,
        statusEntries: async (jobId: string) =>
            (await ctx.jobStore.listHistory(jobId, { limit: 100 })).entries.filter((entry) => entry.field === "status"),
    };
}

const invokeSteerable = (jobPrompt: string): Step =>
    call("invoke", {
        agents: [{ role: "gp", contextMode: "clean", jobPrompt }],
        // biome-ignore lint/suspicious/noThenProperty: `then` is the parameter name the specification gives the tool
        then: "steerable",
    });

type Started = Awaited<ReturnType<typeof start>>;
let startedRef: Started | undefined;
const started_ = (): Started => startedRef as Started;

describe("complete_job", () => {
    it("completes the job and ends the lead's run, the job being To do, In progress, then Done on one thread", async () => {
        const holder = deferred();
        let isHolding = false;
        const started = await start(
            {
                "hold the thread": [
                    {
                        hold: holder.promise,
                        onEntered: () => {
                            isHolding = true;
                        },
                    },
                ],
                "renew the certificate": [
                    call("update_job", { definitionOfDone: "the certificate is valid" }),
                    call("complete_job", { justification: "renewed, valid until 2027" }),
                ],
            },
            1,
        );
        await started.createJob("hold the thread");
        await waitFor(() => isHolding, "the first lead to hold the worker thread");
        const job = await started.createJob("renew the certificate");
        await waitFor(() => started.ctx.admission.state().waiting.length === 1, "the second lead to wait");
        assert.equal(await started.status(job.id), "to_do");

        holder.release();
        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");

        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.deepEqual(stored.resolution, { kind: "completed", justification: "renewed, valid until 2027" });
        const entries = await started.statusEntries(job.id);
        assert.deepEqual(
            entries.map((entry) => [entry.old, entry.new]),
            [
                ["to_do", "in_progress"],
                ["in_progress", "done"],
            ],
        );
        await waitFor(() => started.isIdle(job.leadConversation), "the lead's run to end");
        assert.equal(started.replies["renew the certificate"], 2);
    });
});

const linesOf = async (started: Started, conversationId: string): Promise<string[]> =>
    (await started.ctx.host.readEntries(conversationId, { limit: 100 })).entries.flatMap((entry) => {
        const line = conversationEntryLine(entry);
        return line === undefined ? [] : [line];
    });

describe("complete_job as the only call of its turn", () => {
    it("records a result that is not an error, settles the input, sends no further request and closes the job's conversations", async () => {
        const gate = deferred();
        let isWorkerRunning = false;
        let leadId: string | undefined;
        let followUp: { submissionId: string } | undefined;
        const started = await start({
            "lead with worker": [
                invokeSteerable("worker task"),
                call("update_job", { definitionOfDone: "the worker is stopped" }),
                {
                    calls: [{ name: "complete_job", arguments: { justification: "stopped" } }],
                    before: async () => {
                        await waitFor(() => leadId !== undefined, "the lead's id");
                        followUp = await submitInput(started_().ctx.host, leadId as string, {
                            content: "late question",
                            requestId: "late-1",
                            busyMode: "followUp",
                        });
                    },
                },
            ],
            "worker task": [
                {
                    hold: gate.promise,
                    onEntered: () => {
                        isWorkerRunning = true;
                    },
                },
            ],
        });
        startedRef = started;
        const job = await started.createJob("lead with worker");
        leadId = job.leadConversation;
        await waitFor(() => isWorkerRunning, "the invoked agent to run");
        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead's run to end");
        await new Promise((resolve) => setTimeout(resolve, 300));

        const lines = await linesOf(started, job.leadConversation);
        assert.ok(lines.includes("tool complete_job returned"), lines.join("\n"));
        assert.equal(started.replies["lead with worker"], 3, "no model request follows the complete call");
        const state = (await started.invoke("submissions.get", {
            submissionId: (followUp as { submissionId: string }).submissionId,
        })) as {
            state: string;
            reason?: string;
        };
        assert.deepEqual(state, { state: "unanswered", reason: "closed" });
        const conversations = await started.ctx.host.listConversations();
        for (const { id } of conversations)
            assert.equal((await readConversationMeta(started.ctx.host, id))?.closed, true);
        for (const { id } of conversations) assert.equal(await started.isIdle(id), true);
        assert.equal(
            lines.some((line) => line.includes("aborted")),
            false,
            lines.join("\n"),
        );
        gate.release();
    });
});

describe("complete_job sharing its turn with another call", () => {
    it("returns an error result naming the rule, lets the other tool finish and completes on a later call made alone", async () => {
        let leadJobId: string | undefined;
        let statusBeforeAloneCall: string | undefined;
        const started = await start({
            "share the turn": [
                call("update_job", { definitionOfDone: "the note is written" }),
                {
                    calls: [
                        { name: "complete_job", arguments: { justification: "too early" } },
                        { name: "add_worklog", arguments: { text: "the note" } },
                    ],
                },
                {
                    calls: [{ name: "complete_job", arguments: { justification: "alone now" } }],
                    before: async () => {
                        statusBeforeAloneCall = await started_().status(leadJobId as string);
                    },
                },
            ],
        });
        startedRef = started;
        const job = await started.createJob("share the turn");
        leadJobId = job.id;
        await waitFor(() => started.replies["share the turn"] === 3, "the lead to see the shared turn's results");

        const [, completeResult, worklogResult] = started.results["share the turn"] ?? [];
        assert.equal(completeResult?.isError, true);
        assert.match(completeResult?.text ?? "", /only tool call/);
        assert.equal(worklogResult?.isError, false);
        await waitFor(() => statusBeforeAloneCall !== undefined, "the lead's alone call");
        assert.equal(statusBeforeAloneCall, "in_progress");

        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");
        assert.deepEqual((await started.ctx.jobStore.getJob(job.id)).resolution, {
            kind: "completed",
            justification: "alone now",
        });
    });

    it("returns an error result from each of two complete calls in one turn and leaves the job In progress", async () => {
        const started = await start({
            "complete twice": [
                call("update_job", { definitionOfDone: "the note is written" }),
                {
                    calls: [
                        { name: "complete_job", arguments: { justification: "first" } },
                        { name: "complete_job", arguments: { justification: "second" } },
                    ],
                },
            ],
        });
        const job = await started.createJob("complete twice");
        await waitFor(() => started.replies["complete twice"] === 3, "the lead to see the results");

        const [, first, second] = started.results["complete twice"] ?? [];
        for (const result of [first, second]) {
            assert.equal(result?.isError, true);
            assert.match(result?.text ?? "", /only tool call/);
        }
        assert.equal(await started.status(job.id), "in_progress");
    });
});

describe("a step after the lead's closed mark landed that fails", () => {
    for (const point of ["conversations-closed"] as const) {
        it(`logs it, returns the tool's success and sends no further request when the hook fails at ${point}`, async () => {
            const started = await start(
                {
                    "failing hook": [
                        call("update_job", { definitionOfDone: "the note is written" }),
                        call("complete_job", { justification: "done" }),
                    ],
                },
                undefined,
                (writePoint) => {
                    if (writePoint === point) throw new Error(`hook failed at ${point}`);
                },
            );
            const job = await started.createJob("failing hook");
            await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");
            await waitFor(() => started.isIdle(job.leadConversation), "the lead's run to end");
            await new Promise((resolve) => setTimeout(resolve, 300));

            const lines = await linesOf(started, job.leadConversation);
            assert.ok(lines.includes("tool complete_job returned"), lines.join("\n"));
            assert.equal(started.replies["failing hook"], 2, "no model request follows the complete call");
            assert.ok(
                started.logLines.some((line) => line.includes(`hook failed at ${point}`)),
                "the failure is logged",
            );
        });
    }
});

describe("a step that fails after the lead's closed mark landed, with an invoked agent running", () => {
    it("aborts the invoked agent, returns the tool's success and sends no further request", async () => {
        const gate = deferred();
        let isWorkerRunning = false;
        const started = await start(
            {
                "lead with worker": [
                    invokeSteerable("worker task"),
                    call("update_job", { definitionOfDone: "the worker is stopped" }),
                    call("complete_job", { justification: "stopped" }),
                ],
                "worker task": [
                    {
                        hold: gate.promise,
                        onEntered: () => {
                            isWorkerRunning = true;
                        },
                    },
                ],
            },
            undefined,
            (writePoint) => {
                if (writePoint === "conversations-closed") throw new Error("the step after the marks failed");
            },
        );
        const job = await started.createJob("lead with worker");
        await waitFor(() => isWorkerRunning, "the invoked agent to run");
        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead's run to end");
        await new Promise((resolve) => setTimeout(resolve, 300));

        const invoked = (await started.ctx.host.listConversations())
            .map(({ id }) => id)
            .find((id) => id !== job.leadConversation) as string;
        const lines = await linesOf(started, job.leadConversation);
        assert.ok(lines.includes("tool complete_job returned"), lines.join("\n"));
        assert.equal(started.replies["lead with worker"], 3, "no model request follows the complete call");
        assert.ok(
            started.logLines.some((line) => line.includes("the step after the marks failed")),
            "the failure is logged",
        );
        assert.equal(await started.isIdle(invoked), true, "the invoked agent is aborted");
        gate.release();
    });
});

describe("a closed-mark commit that fails after the complete write", () => {
    it("aborts the lead and the invoked agent, settles the queued input aborted and leaves both open until the next start", async () => {
        const gate = deferred();
        let isWorkerRunning = false;
        let leadId: string | undefined;
        let followUp: { submissionId: string } | undefined;
        const scripts: Record<string, Step[]> = {
            "lead with worker": [
                invokeSteerable("worker task"),
                call("update_job", { definitionOfDone: "the worker is stopped" }),
                {
                    calls: [{ name: "complete_job", arguments: { justification: "stopped" } }],
                    before: async () => {
                        await waitFor(() => leadId !== undefined, "the lead's id");
                        followUp = await submitInput(started_().ctx.host, leadId as string, {
                            content: "late question",
                            requestId: "late-1",
                            busyMode: "followUp",
                        });
                    },
                },
            ],
            "worker task": [
                {
                    hold: gate.promise,
                    onEntered: () => {
                        isWorkerRunning = true;
                    },
                },
            ],
        };
        const started = await start(scripts, undefined, (writePoint) => {
            if (writePoint === "job-completed") throw new Error("the closed-mark commit failed");
        });
        startedRef = started;
        const job = await started.createJob("lead with worker");
        const lead = job.leadConversation;
        leadId = lead;
        await waitFor(() => isWorkerRunning, "the invoked agent to run");
        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");
        await waitFor(() => started.isIdle(lead), "the lead's run to end");
        await new Promise((resolve) => setTimeout(resolve, 300));

        const conversationIds = (await started.ctx.host.listConversations()).map(({ id }) => id);
        const invoked = conversationIds.find((id) => id !== lead) as string;
        const lines = await linesOf(started, lead);
        assert.equal(lines.at(-1), "tool complete_job failed", lines.join("\n"));
        assert.equal(started.replies["lead with worker"], 3, "no model request follows the complete call");
        assert.ok(
            started.logLines.some((line) => line.includes("the closed-mark commit failed")),
            "the failure is logged",
        );
        const submissionIds = [
            (followUp as { submissionId: string }).submissionId,
            await submissionIdFor(started.ctx.host, lead, `lead:${job.id}`),
        ];
        for (const submissionId of submissionIds) {
            assert.deepEqual(await started.invoke("submissions.get", { submissionId }), {
                state: "unanswered",
                reason: "aborted",
            });
        }
        assert.equal(await started.isIdle(invoked), true, "the invoked agent is aborted");
        for (const id of [lead, invoked]) {
            assert.notEqual(await statusOf(started, job.id, id), "closed");
            await assert.rejects(
                started.invoke("conversations.submit", {
                    conversationId: id,
                    content: "hello",
                    requestId: `refused-${id}`,
                    busyMode: "followUp",
                }),
                { code: "conflict" },
            );
        }

        await started.daemon.stop();
        const restarted = await start({}, undefined, undefined, started.env);
        startedRef = restarted;
        await waitFor(async () => (await statusOf(restarted, job.id, lead)) === "closed", "rule 4 to close the lead");
        assert.equal(await statusOf(restarted, job.id, invoked), "closed");
        gate.release();
    });
});

async function statusOf(started: Started, jobId: string, conversationId: string): Promise<string | undefined> {
    const listed = (await started.invoke("conversations.list", { jobId })) as { id: string; status: string }[];
    return listed.find(({ id }) => id === conversationId)?.status;
}

describe("block_job", () => {
    it("blocks the job with the reason, parks its lead and runs the other job's lead", async () => {
        const reason = "which system and what failure?";
        const started = await start(
            {
                "first email": [],
                "second email": [],
                "third email": [call("block_job", { reason })],
                "other job": [],
            },
            1,
        );
        await started.createJob("first email", emailCaller);
        await started.createJob("second email", emailCaller);
        const job = await started.createJob("third email", emailCaller);
        assert.equal(job.number, "E-3");
        const other = await started.createJob("other job");
        await waitFor(() => started.isIdle(other.leadConversation), "the other job's lead to run");

        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "blocked");
        assert.equal(stored.blockedReason, reason);
        assert.equal(await started.status(other.id), "in_progress");
        const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
        assert.equal(meta?.parked?.waitingFor, "answer");
        assert.equal(started.replies["third email"], 1);
    });

    it("refuses a block that shares its round with another call and leaves the job In progress", async () => {
        const started = await start({
            "busy lead": [
                {
                    calls: [
                        { name: "block_job", arguments: { reason: "waiting" } },
                        { name: "add_worklog", arguments: { text: "note" } },
                    ],
                },
            ],
        });
        const job = await started.createJob("busy lead");
        await waitFor(() => started.replies["busy lead"] === 2, "the lead to see the result");

        const [blockResult] = started.results["busy lead"] ?? [];
        assert.equal(blockResult?.isError, true);
        assert.match(blockResult?.text ?? "", /only tool call/);
        assert.equal(await started.status(job.id), "in_progress");
    });
});

describe("empty fields", () => {
    it("returns an error result naming the definition of done and keeps the job In progress", async () => {
        const started = await start({
            "no definition": [call("complete_job", { justification: "done" })],
        });
        const job = await started.createJob("no definition");
        await waitFor(() => started.replies["no definition"] === 2, "the lead to see the result");

        const [result] = started.results["no definition"] ?? [];
        assert.equal(result?.isError, true);
        assert.match(result?.text ?? "", /definition of done/);
        assert.equal(await started.status(job.id), "in_progress");
        assert.equal(started.replies["no definition"], 2);
    });

    it("returns an error result naming the justification when it is empty", async () => {
        const started = await start({
            "empty justification": [
                call("update_job", { definitionOfDone: "the cert is valid" }),
                call("complete_job", { justification: " " }),
            ],
        });
        const job = await started.createJob("empty justification");
        await waitFor(() => started.replies["empty justification"] === 3, "the lead to see the result");

        const result = started.results["empty justification"]?.[1];
        assert.equal(result?.isError, true);
        assert.match(result?.text ?? "", /justification/);
        assert.equal(await started.status(job.id), "in_progress");
    });

    it("returns an error result naming the reason when a block has none", async () => {
        const started = await start({ "no reason": [call("block_job", { reason: "" })] });
        const job = await started.createJob("no reason");
        await waitFor(() => started.replies["no reason"] === 2, "the lead to see the result");

        const [result] = started.results["no reason"] ?? [];
        assert.equal(result?.isError, true);
        assert.match(result?.text ?? "", /blockedReason/);
        assert.equal(await started.status(job.id), "in_progress");
    });
});

describe("a lead that blocks while an invoked agent runs", () => {
    it("gets an error result naming the running invocation and the job stays In progress", async () => {
        const gate = deferred();
        let isRunning = false;
        const started = await start({
            "lead with worker": [invokeSteerable("worker task"), call("block_job", { reason: "stuck" })],
            "worker task": [
                {
                    hold: gate.promise,
                    onEntered: () => {
                        isRunning = true;
                    },
                },
            ],
        });
        const job = await started.createJob("lead with worker");
        await waitFor(() => isRunning, "the invoked agent to run");
        await waitFor(() => started.replies["lead with worker"] === 3, "the lead to see the result of its block");

        const results = started.results["lead with worker"] ?? [];
        const invoked = /Invoked conversations: ([^.\s]+)\./.exec(results[0]?.text ?? "")?.[1];
        assert.ok(invoked);
        assert.equal(results[1]?.isError, true);
        assert.ok(results[1]?.text.includes(invoked));
        assert.equal(await started.status(job.id), "in_progress");
        gate.release();
    });
});

describe("a specialist that calls the lead's tools", () => {
    it("gets an error result for each, leaves the job In progress and goes on", async () => {
        const started = await start({
            "lead of specialist": [invokeSteerable("specialist task")],
            "specialist task": [
                call("block_job", { reason: "I am stuck" }),
                call("complete_job", { justification: "all done" }),
            ],
        });
        const job = await started.createJob("lead of specialist");
        await waitFor(() => started.replies["specialist task"] === 3, "the specialist to finish its script");

        const results = started.results["specialist task"] ?? [];
        assert.deepEqual(
            results.map((result) => result.isError),
            [true, true],
        );
        for (const result of results) assert.match(result.text, /only the job's lead/);
        assert.equal(await started.status(job.id), "in_progress");
    });
});
