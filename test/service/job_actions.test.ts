import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { conversationMetaDoc, readConversationMeta } from "../../src/host/seating.ts";
import {
    blockJob,
    cancelJob,
    completeJob,
    type JobActionDeps,
    resumeJob,
    startJob,
} from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { JobRefusedError } from "../../src/jobs/job_store.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const author: JobAuthor = { kind: "team_member", wayIn: "web interface" };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type CreatedJob = { id: string; number: string; leadConversation: string };
type Started = {
    ctx: ServiceContext;
    fake: FauxProviderRegistration;
    deps: JobActionDeps;
    /** Deps whose afterWrite hook is the given function. */
    depsWith(afterWrite: (point: WritePoint, jobId: string) => void | Promise<void>): JobActionDeps;
    create(): Promise<CreatedJob>;
};

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fake.setResponses([async () => fauxAssistantMessage("done")]);
    fakes.push(fake);
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
        fake,
        deps: { ctx, options: jobs.options },
        depsWith: (afterWrite) => ({ ctx, options: { ...jobs.options, afterWrite } }),
        async create() {
            const job = (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as CreatedJob;
            await waitFor(() => isIdle(ctx, job.leadConversation), "the lead's first run to end");
            return job;
        },
    };
}

async function isIdle(ctx: ServiceContext, conversationId: string): Promise<boolean> {
    return (await ctx.host.conversationInfo(conversationId))?.busy === false;
}

async function isBusy(ctx: ServiceContext, conversationId: string): Promise<boolean> {
    return (await ctx.host.conversationInfo(conversationId))?.busy === true;
}

// Starts a conversation the lead invokes and awaits. Its model reply stays open until the run is aborted.
async function invokeRunning(started: Started, lead: string): Promise<string> {
    started.fake.setResponses([
        (_context, options) =>
            new Promise((resolve) => {
                const finish = () => resolve(fauxAssistantMessage("stopped"));
                if (options?.signal?.aborted) finish();
                options?.signal?.addEventListener("abort", finish);
            }),
    ]);
    const seat = started.deps.options.agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE);
    const [invoked] = await createInvokedConversations(started.ctx.host, {
        invokingId: lead,
        callId: "call-1",
        agents: [{ seat, contextMode: "clean", jobPrompt: "work" }],
        actor: { kind: "team_member", wayIn: "web interface" },
        parked: { waitingFor: "reports", continueOn: "each" },
    });
    const id = invoked as string;
    await waitFor(() => isBusy(started.ctx, id), "the invoked run");
    return id;
}

async function stopAwaiting(ctx: ServiceContext, conversationId: string): Promise<void> {
    await internalHarness(ctx.host).commit(async (tx) => {
        const meta = await tx.doc(conversationMetaDoc, Number(conversationId) as never);
        meta.awaiting = [];
        meta.parked = null;
    }, BACKGROUND_CONTEXT);
}

async function refusal(action: Promise<unknown>): Promise<JobRefusedError> {
    try {
        await action;
    } catch (error) {
        assert.ok(error instanceof JobRefusedError, `expected JobRefusedError, got ${String(error)}`);
        return error;
    }
    throw new Error("expected the action to be refused");
}

const failingHook = () => {
    throw new Error("hook failed");
};

describe("blockJob", () => {
    it("commits Blocked before the lead parks, and the parked lead holds no worker thread", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);
        const seen: { status?: string; reason?: string; parked?: unknown }[] = [];
        const deps = started.depsWith(async (point, jobId) => {
            if (point !== "job-blocked") return;
            const stored = await started.ctx.jobStore.getJob(jobId);
            const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
            seen.push({ status: stored.status, reason: stored.blockedReason, parked: meta?.parked });
        });

        const blocked = await blockJob(deps, job.id, "waiting for the schema", author);

        assert.equal(blocked.status, "blocked");
        assert.deepEqual(seen, [{ status: "blocked", reason: "waiting for the schema", parked: null }]);
        const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
        assert.deepEqual(meta?.parked, { waitingFor: "answer", continueOn: "each" });
        assert.equal(await isIdle(started.ctx, job.leadConversation), true);
    });

    it("refuses invalid_input naming the conversation the lead awaits, and leaves the job In progress", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);
        const invoked = await invokeRunning(started, job.leadConversation);

        const refused = await refusal(blockJob(started.deps, job.id, "stuck", author));

        assert.equal(refused.code, "invalid_input");
        assert.ok(refused.message.includes(invoked), refused.message);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    it("refuses invalid_input naming a running invoked conversation of the job that is not awaited", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);
        const invoked = await invokeRunning(started, job.leadConversation);
        await stopAwaiting(started.ctx, job.leadConversation);

        const refused = await refusal(blockJob(started.deps, job.id, "stuck", author));

        assert.equal(refused.code, "invalid_input");
        assert.ok(refused.message.includes(invoked), refused.message);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    it("leaves Blocked committed and the lead unparked when afterWrite throws", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);

        await assert.rejects(blockJob(started.depsWith(failingHook), job.id, "waiting", author), /hook failed/);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
    });
});

describe("completeJob and cancelJob", () => {
    for (const [name, act, kind] of [
        ["completeJob", completeJob, "completed"],
        ["cancelJob", cancelJob, "cancelled"],
    ] as const) {
        const point = kind === "completed" ? "job-completed" : "job-cancelled";

        it(`${name} commits Done before aborting, and then nothing of the job is left`, async () => {
            const started = await start();
            const job = await started.create();
            await started.ctx.jobStore.updateFields(job.id, { definitionOfDone: "it is done" }, author);
            await startJob(started.deps, job.id);
            const invoked = await invokeRunning(started, job.leadConversation);
            const seen: { status?: string; resolution?: unknown; invokedBusy?: boolean }[] = [];
            const deps = started.depsWith(async (at, jobId) => {
                if (at !== point) return;
                const stored = await started.ctx.jobStore.getJob(jobId);
                seen.push({
                    status: stored.status,
                    resolution: stored.resolution,
                    invokedBusy: await isBusy(started.ctx, invoked),
                });
            });

            const done = await act(deps, job.id, "because", author);

            assert.equal(done.status, "done");
            assert.deepEqual(seen, [
                { status: "done", resolution: { kind, justification: "because" }, invokedBusy: true },
            ]);
            for (const id of [job.leadConversation, invoked]) {
                const meta = await readConversationMeta(started.ctx.host, id);
                assert.equal(meta?.parked, null);
                assert.deepEqual(meta?.awaiting, []);
                await waitFor(() => isIdle(started.ctx, id), "the abort");
            }
        });

        it(`${name} leaves Done committed and the conversations untouched when afterWrite throws`, async () => {
            const started = await start();
            const job = await started.create();
            await started.ctx.jobStore.updateFields(job.id, { definitionOfDone: "it is done" }, author);
            await startJob(started.deps, job.id);
            const invoked = await invokeRunning(started, job.leadConversation);

            await assert.rejects(act(started.depsWith(failingHook), job.id, "because", author), /hook failed/);

            assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
            assert.equal(await isBusy(started.ctx, invoked), true);
            const lead = await readConversationMeta(started.ctx.host, job.leadConversation);
            assert.deepEqual(lead?.awaiting, [invoked]);
        });
    }
});

describe("the action sequence", () => {
    it("holds two field entries, the status changes, the blocked reason, the resolution and no worklog", async () => {
        const started = await start();
        const job = await started.create();
        const store = started.ctx.jobStore;
        await store.updateFields(job.id, { definitionOfDone: "it is done" }, author);
        await store.updateFields(job.id, { title: "a title" }, author);
        await startJob(started.deps, job.id);
        await startJob(started.deps, job.id);
        await blockJob(started.deps, job.id, "waiting", author);
        await resumeJob(started.deps, job.id, author);
        await resumeJob(started.deps, job.id, author);
        await completeJob(started.deps, job.id, "shipped", author);

        const { entries } = await store.listHistory(job.id, { limit: 100 });
        const changes = entries.map((entry) => [entry.field, entry.old, entry.new]);
        const of = (field: string) => changes.filter(([name]) => name === field);
        assert.equal(of("title").length + of("definitionOfDone").length, 2);
        assert.deepEqual(of("status"), [
            ["status", "to_do", "in_progress"],
            ["status", "in_progress", "blocked"],
            ["status", "blocked", "in_progress"],
            ["status", "in_progress", "done"],
        ]);
        assert.deepEqual(of("blockedReason"), [
            ["blockedReason", null, "waiting"],
            ["blockedReason", "waiting", null],
        ]);
        assert.deepEqual(of("resolution"), [["resolution", null, { kind: "completed", justification: "shipped" }]]);
        assert.equal(entries.length, 2 + 4 + 2 + 1);
        for (const entry of entries) assert.ok(entry.at && entry.author, "each entry has its time and author");
        assert.deepEqual((await store.listWorklog(job.id, {})).entries, []);
    });
});
