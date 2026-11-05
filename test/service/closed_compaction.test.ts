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
import { readConversationMeta } from "../../src/host/seating.ts";
import { cancelJob, type JobActionDeps } from "../../src/jobs/job_actions.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_MS = 300;
// The model's window is 128000 tokens and a background compaction starts 32768 tokens below the blocking threshold.
// This reserve puts that start 100 tokens into the context and the blocking threshold far above it, so the
// compaction starts at the lead's second turn and does not block it.
const BLOCKING_MARGIN_RESERVE = 128000 - 32768 - 100;
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const gates: (() => void)[] = [];

afterEach(async () => {
    for (const release of gates.splice(0)) release();
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

type Rig = Awaited<ReturnType<typeof start>>;

/**
 * A daemon whose lead follows `leadSteps`, one tool call per model reply; every other request is answered "done".
 * The compaction's summarization request is held until `releaseSummary()` or until it is aborted.
 * Every conversation starts a background compaction at its second turn.
 */
async function start(leadSteps: { name: string; args: Record<string, unknown> }[]) {
    const env = await createHermeticEnv();
    envs.push(env);
    const logger = createLogger({ stream: { write: () => true } });
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const summary = { requests: 0, isAborted: false };
    const turns = { count: 0 };
    let releaseSummary = (): void => {};
    const summaryGate = new Promise<void>((resolve) => {
        releaseSummary = resolve;
    });
    gates.push(releaseSummary);
    const respond: FauxResponseFactory = async (context, streamOptions) => {
        fake.appendResponses([respond]);
        const isSummarization = context.messages.some(
            (message) =>
                message.role === "system" && textOf(message.content).includes("context summarization assistant"),
        );
        if (isSummarization) {
            summary.requests++;
            const signal = streamOptions?.signal;
            const isAborted = new Promise<void>((resolve) => {
                const markAborted = (): void => {
                    summary.isAborted = true;
                    resolve();
                };
                if (signal?.aborted) markAborted();
                signal?.addEventListener("abort", markAborted);
            });
            await Promise.race([summaryGate, isAborted]);
            return fauxAssistantMessage("the summary");
        }
        const first = context.messages.find((message) => message.role === "user");
        if (first === undefined || !textOf(first.content).includes("lead with compaction")) {
            return fauxAssistantMessage("done");
        }
        const index = context.messages.filter((message) => message.role === "assistant").length;
        turns.count++;
        const step = leadSteps[index];
        if (step === undefined) return fauxAssistantMessage("finished");
        return fauxAssistantMessage([fauxToolCall(step.name, step.args as never)], { stopReason: "toolUse" });
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({
            defaultProvider: provider,
            defaultModel: "model-one",
            compaction: { keepRecentTokens: 1, reserveTokens: BLOCKING_MARGIN_RESERVE },
        }),
    );
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
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
        logger,
        sections: agents.sections,
        components: [agents.component, jobs.component, probe],
        operations: [...agents.operations, ...jobs.operations],
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
        deps: { ctx, options: jobs.options } as JobActionDeps,
        summary,
        turns,
        releaseSummary: () => releaseSummary(),
        createJob: async () =>
            (await daemon.catalogue.invoke("jobs.create", { text: "lead with compaction" }, webCaller)) as {
                id: string;
                leadConversation: string;
            },
        isIdle: async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false,
        status: async (jobId: string) => (await ctx.jobStore.getJob(jobId)).status,
        kinds: async (id: string) => (await ctx.host.readEntries(id, { limit: 100 })).entries.map((e) => e.kind),
        lines: async (id: string) =>
            (await ctx.host.readEntries(id, { limit: 100 })).entries.flatMap((entry) => {
                const line = conversationEntryLine(entry);
                return line === undefined ? [] : [line];
            }),
    };
}

/** Lets a released or stray summary finish, then checks that none was placed. */
async function assertNoSummaryPlaced(rig: Rig, conversationId: string): Promise<void> {
    rig.releaseSummary();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    assert.ok(!(await rig.kinds(conversationId)).includes("pi.compaction"), "no compaction entry is placed");
}

describe("a compaction running when the job becomes Done", () => {
    it("is aborted when the lead completes the job, which still records the tool's success and ends the run", async () => {
        const rig = await start([
            { name: "update_job", args: { definitionOfDone: "the work is stopped" } },
            { name: "complete_job", args: { justification: "stopped" } },
        ]);
        const job = await rig.createJob();
        await waitFor(async () => (await rig.status(job.id)) === "done", "the job to be Done");
        await waitFor(() => rig.isIdle(job.leadConversation), "the lead's run to end");
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

        assert.equal(rig.summary.requests, 1, "the compaction was running");
        assert.equal(rig.summary.isAborted, true, "the compaction's model request is aborted");
        assert.ok((await rig.lines(job.leadConversation)).includes("tool complete_job returned"));
        assert.equal(rig.turns.count, 2, "no model request follows the complete call");
        await assertNoSummaryPlaced(rig, job.leadConversation);
    });

    it("is aborted when a team member cancels the job", async () => {
        const rig = await start([
            { name: "update_job", args: { definitionOfDone: "the work is stopped" } },
            { name: "block_job", args: { reason: "which build is failing?" } },
        ]);
        const job = await rig.createJob();
        await waitFor(async () => (await rig.status(job.id)) === "blocked", "the job to be Blocked");
        assert.equal(rig.summary.requests, 1, "the compaction is running");
        const turnsBefore = rig.turns.count;

        await cancelJob(rig.deps, job.id, "no longer needed", { kind: "team_member", wayIn: "web interface" });
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

        assert.equal((await readConversationMeta(rig.ctx.host, job.leadConversation))?.closed, true);
        assert.equal(rig.summary.isAborted, true, "the compaction's model request is aborted");
        assert.equal(rig.turns.count, turnsBefore, "no further model turn");
        await assertNoSummaryPlaced(rig, job.leadConversation);
    });
});
