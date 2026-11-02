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
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
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
type Step = { calls: Call[] } | { hold: Promise<unknown>; onEntered?: () => void };
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
async function start(scripts: Record<string, Step[]>, workerThreadCount?: number) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const results: Record<string, ToolResultSeen[]> = {};
    const replies: Record<string, number> = {};
    const respond: FauxResponseFactory = async (context) => {
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
            await step.hold;
            return fauxAssistantMessage("done");
        }
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
    const jobs = await createJobsComponent({ agents, logger: quietLogger });
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
