import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput } from "../../src/host/conversation_control.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { RESUME_REQUEST_PREFIX } from "../../src/jobs/job_actions.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type CreatedJob = { id: string; number: string; leadConversation: string };
type Booted = {
    daemon: RunningDaemon;
    ctx: ServiceContext;
    agents: Awaited<ReturnType<typeof createAgentsComponent>>;
    create(): Promise<CreatedJob>;
};

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function newFake(): FauxProviderRegistration {
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    return fake;
}

async function hermetic(fake: FauxProviderRegistration): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: "model-one" }),
    );
    return env;
}

// One worker thread, so a second lead has to wait for the first.
async function boot(
    env: HermeticEnv,
    fake: FauxProviderRegistration,
    onContext: (ctx: ServiceContext) => void = () => {},
): Promise<Booted> {
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    let captured: ServiceContext | undefined;
    // The context is taken at step 5 so a model reply of a run that resumes at step 7 can already read the job store.
    const probe: DaemonComponent = {
        name: "probe",
        checkModels: async (ctx) => {
            captured = ctx;
            onContext(ctx);
        },
    };
    const provider = fake.getModel().provider;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, jobs.component, probe],
        operations: [...agents.operations, ...jobs.operations],
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
    await waitFor(async () => daemon.phase() === "ready", "the daemon to become ready");
    return {
        daemon,
        ctx: captured as ServiceContext,
        agents,
        create: async () => (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as CreatedJob,
    };
}

const isIdle = async (ctx: ServiceContext, id: string): Promise<boolean> =>
    (await ctx.host.conversationInfo(id))?.busy === false;

const statusOf = async (ctx: ServiceContext, jobId: string): Promise<string> =>
    (await ctx.jobStore.getJob(jobId)).status;

const statusEntries = async (ctx: ServiceContext, jobId: string) =>
    (await ctx.jobStore.listHistory(jobId, { limit: 100 })).entries.filter((entry) => entry.field === "status");

type StatusByJob = Record<string, string>;

/** A model reply that records the status of every job at the moment the model is called. */
function recordingReply(getContext: () => ServiceContext, seen: StatusByJob[]) {
    return async () => {
        const { jobs } = await getContext().jobStore.listJobs({});
        seen.push(Object.fromEntries(jobs.map((job) => [job.id, job.status])));
        return fauxAssistantMessage("done");
    };
}

/** A model reply that stays open until `release` is called or the run is aborted. */
function gatedReply() {
    let release = (): void => {};
    let isEntered = false;
    const reply = (_context: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
            isEntered = true;
            release = () => resolve(fauxAssistantMessage("done"));
            options?.signal?.addEventListener("abort", release);
        });
    return { reply, release: () => release(), isEntered: () => isEntered };
}

describe("the start action", () => {
    it("keeps a job To do while its lead waits, then starts it before the lead's first model request", async () => {
        const fake = newFake();
        const { ctx, create } = await boot(await hermetic(fake), fake);
        const gate = gatedReply();
        const seen: StatusByJob[] = [];
        fake.setResponses([gate.reply, recordingReply(() => ctx, seen)]);

        const first = await create();
        await waitFor(async () => gate.isEntered(), "the first lead's model request");
        const second = await create();
        await waitFor(async () => ctx.admission.state().waiting.length === 1, "the second lead to wait");

        assert.equal(await statusOf(ctx, first.id), "in_progress");
        assert.equal(await statusOf(ctx, second.id), "to_do");
        gate.release();
        await waitFor(() => isIdle(ctx, second.leadConversation), "the second lead's run to end");

        assert.deepEqual(seen, [{ [first.id]: "in_progress", [second.id]: "in_progress" }]);
        const entries = await statusEntries(ctx, second.id);
        assert.deepEqual(
            entries.map((entry) => [entry.author, entry.old, entry.new]),
            [[{ kind: "daemon" }, "to_do", "in_progress"]],
        );
    });

    it("leaves the status unchanged when a later run or an invoked conversation takes a worker thread", async () => {
        const fake = newFake();
        const { ctx, create, agents } = await boot(await hermetic(fake), fake);
        fake.setResponses([async () => fauxAssistantMessage("done")]);
        const job = await create();
        await waitFor(() => isIdle(ctx, job.leadConversation), "the first run to end");
        fake.setResponses([
            async () => fauxAssistantMessage("again"),
            async () => fauxAssistantMessage("invoked"),
            async () => fauxAssistantMessage("reported"),
            async () => fauxAssistantMessage("later"),
        ]);

        await submitInput(ctx.host, job.leadConversation, { content: "more", requestId: "r2", busyMode: "followUp" });
        await waitFor(async () => fake.state.callCount === 2 && (await isIdle(ctx, job.leadConversation)), "run 2");
        const [invoked] = await createInvokedConversations(ctx.host, {
            invokingId: job.leadConversation,
            callId: "call-1",
            agents: [
                {
                    seat: agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE),
                    contextMode: "clean",
                    jobPrompt: "work",
                },
            ],
            actor: { kind: "team_member", wayIn: "web interface" },
            parked: { waitingFor: "reports", continueOn: "each" },
        });
        // The invoked conversation reports to the lead, whose run follows.
        await waitFor(
            async () => fake.state.callCount === 4 && (await isIdle(ctx, job.leadConversation)),
            "the report run",
        );
        assert.equal(await isIdle(ctx, invoked as string), true);
        await ctx.jobStore.applyAction(job.id, "block", { blockedReason: "waiting" }, { kind: "daemon" });
        const before = await statusEntries(ctx, job.id);

        // Input that jobs.resume writes itself doesn't resume the job here.
        await submitInput(ctx.host, job.leadConversation, {
            content: "later",
            requestId: `${RESUME_REQUEST_PREFIX}r3`,
            busyMode: "followUp",
        });
        await waitFor(async () => fake.state.callCount === 5 && (await isIdle(ctx, job.leadConversation)), "run 5");

        assert.equal(await statusOf(ctx, job.id), "blocked");
        assert.deepEqual(await statusEntries(ctx, job.id), before);
    });

    it("writes the start when a run of a To do lead resumes after the daemon restarts", async () => {
        const fake = newFake();
        const env = await hermetic(fake);
        const first = await boot(env, fake);
        const gate = gatedReply();
        fake.setResponses([gate.reply]);
        await first.create();
        await waitFor(async () => gate.isEntered(), "the holding lead's model request");
        const waiting = await first.create();
        await waitFor(async () => first.ctx.admission.state().waiting.length === 1, "the second lead to wait");
        assert.equal(await statusOf(first.ctx, waiting.id), "to_do");
        await first.daemon.stop();

        const seen: StatusByJob[] = [];
        let restarted: ServiceContext | undefined;
        const reply = recordingReply(() => restarted as ServiceContext, seen);
        fake.setResponses([reply, reply]);
        const second = await boot(env, fake, (ctx) => {
            restarted = ctx;
        });

        await waitFor(() => isIdle(second.ctx, waiting.leadConversation), "the resumed lead to end");
        assert.equal(await statusOf(second.ctx, waiting.id), "in_progress");
        assert.equal((await statusEntries(second.ctx, waiting.id)).length, 1);
        // The holding lead resumes first and finds the job To do behind it; the waiting lead's request is the last.
        assert.equal(seen.length, 2);
        assert.equal(seen.at(-1)?.[waiting.id], "in_progress");
    });

    it("grants the worker thread and writes nothing when a lead's job isn't in the job store", async () => {
        const fake = newFake();
        const { ctx, agents } = await boot(await hermetic(fake), fake);
        fake.setResponses([async () => fauxAssistantMessage("done")]);
        const { conversationId } = await createSeatedConversation(ctx.host, {
            scope: "test",
            key: "orphan",
            job: { jobId: "no-such-job", isLead: true, origin: { kind: "request", wayIn: "test" }, depth: 0 },
            seat: agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE),
            actor: { kind: "team_member", wayIn: "test" },
        });

        await submitInput(ctx.host, conversationId, { content: "go", requestId: "r1", busyMode: "followUp" });
        await waitFor(async () => fake.state.callCount === 1 && (await isIdle(ctx, conversationId)), "the run");

        assert.deepEqual((await ctx.jobStore.listJobs({})).jobs, []);
    });
});
