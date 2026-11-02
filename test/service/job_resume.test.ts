import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput } from "../../src/host/conversation_control.ts";
import { createSeatedConversation, readConversationMeta } from "../../src/host/seating.ts";
import { steerConversation } from "../../src/host/steering.ts";
import { blockJob, type JobActionDeps, RESUME_REQUEST_PREFIX, startJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const ANSWER = "the nightly build on ci-2";
const BLOCKED_REASON = "which build is failing?";
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
    /** The deps the Jobs component itself uses: setting `options.afterWrite` hooks its listener too. */
    deps: JobActionDeps;
    /** The user messages of every model call so far, in order. */
    modelInputs: string[][];
    depsWith(afterWrite: (point: WritePoint, jobId: string) => void | Promise<void>): JobActionDeps;
    create(): Promise<CreatedJob>;
    submit(conversationId: string, requestId: string): Promise<unknown>;
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const textOf = (message: Message): string => {
    const { content } = message;
    if (typeof content === "string") return content;
    return content.map((block) => ("text" in block ? block.text : "")).join("");
};

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const modelInputs: string[][] = [];
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        modelInputs.push(context.messages.filter((m) => m.role === "user").map(textOf));
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
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
        modelInputs,
        deps: { ctx, options: jobs.options },
        depsWith: (afterWrite) => ({ ctx, options: { ...jobs.options, afterWrite } }),
        async create() {
            const job = (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as CreatedJob;
            await waitFor(() => isIdle(ctx, job.leadConversation), "the lead's first run to end");
            return job;
        },
        submit: (conversationId, requestId) =>
            daemon.catalogue.invoke(
                "conversations.submit",
                { conversationId, content: ANSWER, requestId, busyMode: "reject" },
                webCaller,
            ),
    };
}

async function isIdle(ctx: ServiceContext, id: string): Promise<boolean> {
    return (await ctx.host.conversationInfo(id))?.busy === false;
}

const hasReceived = (started: Started, content: string) => started.modelInputs.some((users) => users.includes(content));

async function blockedJob(started: Started): Promise<CreatedJob> {
    const job = await started.create();
    await startJob(started.deps, job.id);
    await blockJob(started.deps, job.id, BLOCKED_REASON, author);
    return job;
}

async function historyOf(started: Started, jobId: string) {
    return (await started.ctx.jobStore.listHistory(jobId, { limit: 100 })).entries;
}

describe("input to a Blocked job's lead", () => {
    it("resumes the job when a team member submits to its parked lead, which continues with the answer", async () => {
        const started = await start();
        const job = await blockedJob(started);

        await started.submit(job.leadConversation, "answer-1");

        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the answer");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
        const changes = (await historyOf(started, job.id)).filter((entry) => entry.field === "blockedReason");
        assert.deepEqual(
            changes.map((entry) => [entry.old, entry.new, entry.author]),
            [
                [null, BLOCKED_REASON, author],
                [BLOCKED_REASON, null, { kind: "daemon" }],
            ],
        );
    });

    it("commits the input to the lead conversation before it writes the resume", async () => {
        const started = await start();
        const job = await blockedJob(started);
        const seen: { status: string; isInputThere: boolean }[] = [];
        started.deps.options.afterWrite = async (point, jobId) => {
            if (point !== "lead-input") return;
            const { entries } = await started.ctx.host.readEntries(job.leadConversation, { limit: 100 });
            seen.push({
                status: (await started.ctx.jobStore.getJob(jobId)).status,
                isInputThere: JSON.stringify(entries).includes(ANSWER),
            });
        };

        await started.submit(job.leadConversation, "answer-1");

        assert.deepEqual(seen, [{ status: "blocked", isInputThere: true }]);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    it("resumes the job and leaves the lead continuing when the input comes before the lead has parked", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);
        const deps = started.depsWith(async (point) => {
            if (point === "job-blocked") await started.submit(job.leadConversation, "answer-1");
        });

        await blockJob(deps, job.id, BLOCKED_REASON, author);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the answer");
        await waitFor(() => isIdle(started.ctx, job.leadConversation), "the lead's run to end");
    });

    it("leaves the lead unparked when the input is read as Blocked before the park and resumes after it", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let signalRead: () => void = () => undefined;
        const listenerRead = new Promise<void>((resolve) => {
            signalRead = resolve;
        });
        started.deps.options.afterWrite = async (point) => {
            if (point !== "lead-input") return;
            signalRead();
            await gate;
        };
        let submitted: Promise<unknown> = Promise.resolve();
        const deps = started.depsWith(async (point) => {
            if (point !== "job-blocked") return;
            submitted = started.submit(job.leadConversation, "answer-1");
            await listenerRead;
        });

        await blockJob(deps, job.id, BLOCKED_REASON, author);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.notEqual((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
        release();
        await submitted;

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the answer");
    });

    it("resumes the job when an agent steers its lead", async () => {
        const started = await start();
        const job = await blockedJob(started);

        await steerConversation(started.ctx.host, job.leadConversation, {
            content: ANSWER,
            mode: "steer",
            actor: { kind: "agent", conversationId: "1", role: DEFAULT_LEAD_ROLE },
            requestId: "steer-1",
        });

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the steer");
    });

    it("leaves the status of a job that is not Blocked unchanged", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);
        const before = (await historyOf(started, job.id)).length;

        await started.submit(job.leadConversation, "answer-1");
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the input");

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await historyOf(started, job.id)).length, before);
    });

    it("changes no job for input to a conversation that is not a lead", async () => {
        const started = await start();
        const job = await blockedJob(started);
        const { conversationId } = await createSeatedConversation(started.ctx.host, {
            scope: "test",
            key: "member",
            job: { jobId: job.id, isLead: false, origin: { kind: "request", wayIn: "test" }, depth: 1 },
            seat: started.deps.options.agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE),
            actor: { kind: "team_member", wayIn: "test" },
        });

        await submitInput(started.ctx.host, conversationId, {
            content: "more",
            requestId: "more-1",
            busyMode: "followUp",
        });
        await waitFor(() => hasReceived(started, "more"), "the conversation to receive the input");

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "blocked");
    });

    it("changes no job for input to a lead whose job the job store doesn't hold", async () => {
        const started = await start();
        const job = await blockedJob(started);
        const { conversationId } = await createSeatedConversation(started.ctx.host, {
            scope: "test",
            key: "orphan",
            job: { jobId: "no-such-job", isLead: true, origin: { kind: "request", wayIn: "test" }, depth: 0 },
            seat: started.deps.options.agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE),
            actor: { kind: "team_member", wayIn: "test" },
        });

        await submitInput(started.ctx.host, conversationId, {
            content: "orphan input",
            requestId: "orphan-1",
            busyMode: "followUp",
        });
        await waitFor(() => hasReceived(started, "orphan input"), "the orphan lead to receive the input");

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.equal((await started.ctx.jobStore.listJobs({})).jobs.length, 1);
    });

    it("skips an input whose request id starts with resume:, which jobs.resume writes itself", async () => {
        const started = await start();
        const job = await blockedJob(started);

        await submitInput(started.ctx.host, job.leadConversation, {
            content: "resumed by a team member",
            requestId: `${RESUME_REQUEST_PREFIX}${job.id}:1`,
            busyMode: "followUp",
        });
        await waitFor(() => hasReceived(started, "resumed by a team member"), "the lead to receive the input");

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "blocked");
    });
});
