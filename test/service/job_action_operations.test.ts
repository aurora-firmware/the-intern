import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { blockJob, type JobActionDeps, startJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import { RESUMED_NOTE } from "../../src/service/job_action_operations.ts";
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
    fake: FauxProviderRegistration;
    /** The deps the Jobs component itself uses: setting `options.afterWrite` hooks its listener too. */
    deps: JobActionDeps;
    /** The user messages of every model call so far, in order. */
    modelInputs: string[][];
    depsWith(afterWrite: (point: WritePoint, jobId: string) => void | Promise<void>): JobActionDeps;
    create(): Promise<CreatedJob>;
    invoke<T = unknown>(name: string, input: unknown, as?: Caller): Promise<T>;
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
    await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
    const ctx = captured as ServiceContext;
    return {
        ctx,
        fake,
        modelInputs,
        deps: { ctx, options: jobs.options },
        depsWith: (afterWrite) => ({ ctx, options: { ...jobs.options, afterWrite } }),
        async create() {
            const job = (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as CreatedJob;
            await waitFor(() => isIdle(ctx, job.leadConversation), "the lead's first run to end");
            return job;
        },
        invoke: (name, input, as = webCaller) => daemon.catalogue.invoke(name, input, as) as never,
    };
}

async function isIdle(ctx: ServiceContext, id: string): Promise<boolean> {
    return (await ctx.host.conversationInfo(id))?.busy === false;
}

async function isBusy(ctx: ServiceContext, id: string): Promise<boolean> {
    return (await ctx.host.conversationInfo(id))?.busy === true;
}

const hasReceived = (started: Started, content: string) => started.modelInputs.some((users) => users.includes(content));

const DONE_WHEN = "the build is green";

// A job with a definition of done, started, so that the lead's end of turn does not block it again.
async function startedJob(started: Started): Promise<CreatedJob> {
    const job = await started.create();
    await started.ctx.jobStore.updateFields(job.id, { definitionOfDone: DONE_WHEN }, author);
    await startJob(started.deps, job.id);
    return job;
}

async function blockedJob(started: Started): Promise<CreatedJob> {
    const job = await startedJob(started);
    await blockJob(started.deps, job.id, BLOCKED_REASON, author);
    return job;
}

async function historyOf(started: Started, jobId: string) {
    return (await started.ctx.jobStore.listHistory(jobId, { limit: 100 })).entries;
}

type SteerData = { actor: SeatActor; mode: string; content?: string };

async function steersOf(started: Started, conversationId: string): Promise<SteerData[]> {
    const conversation = await internalHarness(started.ctx.host).conversation(
        Number(conversationId) as ConversationId,
        BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    return (page?.items ?? []).filter((entry) => entry.kind === STEER_RECORD_KIND).map((e) => e.data as SteerData);
}

async function failure(action: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
        await action;
    } catch (error) {
        return error as { code: string; message: string };
    }
    throw new Error("expected the operation to be refused");
}

// Starts two conversations the lead invokes and awaits. Their model replies stay open until their runs are aborted.
async function invokeTwoRunning(started: Started, lead: string): Promise<string[]> {
    const holdUntilAborted = (_context: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
            const finish = () => resolve(fauxAssistantMessage("stopped"));
            if (options?.signal?.aborted) finish();
            options?.signal?.addEventListener("abort", finish);
        });
    started.fake.setResponses([holdUntilAborted, holdUntilAborted]);
    const seat = started.deps.options.agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE);
    const ids = (await createInvokedConversations(started.ctx.host, {
        invokingId: lead,
        callId: "call-1",
        agents: [
            { seat, contextMode: "clean", jobPrompt: "work" },
            { seat, contextMode: "clean", jobPrompt: "more work" },
        ],
        actor: { kind: "team_member", wayIn: "web interface" },
        parked: { waitingFor: "reports", continueOn: "each" },
    })) as string[];
    for (const id of ids) await waitFor(() => isBusy(started.ctx, id), "an invoked run");
    return ids;
}

describe("jobs.resume", () => {
    it("delivers the text to the parked lead as a steer naming the team member, then resumes the job", async () => {
        const started = await start();
        const job = await blockedJob(started);

        const resumed = await started.invoke<{ status: string }>("jobs.resume", { job: job.id, text: ANSWER });

        assert.equal(resumed.status, "in_progress");
        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the text");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
        const steers = await steersOf(started, job.leadConversation);
        assert.deepEqual(
            steers.map((steer) => [steer.actor, steer.mode, steer.content]),
            [[{ kind: "team_member", wayIn: "web interface" }, "followUp", ANSWER]],
        );
        const resumes = (await historyOf(started, job.id)).filter(
            (entry) => entry.field === "status" && entry.old === "blocked",
        );
        assert.deepEqual(
            resumes.map((entry) => entry.author),
            [author],
        );
    });

    it("delivers a note that a team member resumed the job when there is no text", async () => {
        const started = await start();
        const job = await blockedJob(started);

        await started.invoke("jobs.resume", { job: job.id });

        await waitFor(() => hasReceived(started, RESUMED_NOTE), "the lead to receive the note");
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    it("numbers the request by the job's blocks, so a second block and resume delivers again", async () => {
        const started = await start();
        const job = await blockedJob(started);
        await started.invoke("jobs.resume", { job: job.id, text: ANSWER });
        await waitFor(() => isIdle(started.ctx, job.leadConversation), "the lead's run to end");
        await blockJob(started.deps, job.id, BLOCKED_REASON, author);

        await started.invoke("jobs.resume", { job: job.id, text: "again" });

        await waitFor(() => hasReceived(started, "again"), "the lead to receive the second text");
        assert.equal((await steersOf(started, job.leadConversation)).length, 2);
    });

    it("refuses conflict, and delivers nothing, for a job that is not Blocked", async () => {
        const started = await start();
        const job = await startedJob(started);
        await waitFor(() => isIdle(started.ctx, job.leadConversation), "the lead's run to end");

        const refused = await failure(started.invoke("jobs.resume", { job: job.id, text: ANSWER }));

        assert.equal(refused.code, "conflict");
        assert.deepEqual(await steersOf(started, job.leadConversation), []);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    it("resumes the job and leaves the lead continuing when it lands between the block and the park", async () => {
        const started = await start();
        const job = await startedJob(started);
        const deps = started.depsWith(async (point) => {
            if (point === "job-blocked") await started.invoke("jobs.resume", { job: job.id, text: ANSWER });
        });

        await blockJob(deps, job.id, BLOCKED_REASON, author);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the text");
    });

    it("resumes once and delivers once when two resumes land together", async () => {
        const started = await start();
        const job = await blockedJob(started);

        const results = await Promise.allSettled([
            started.invoke("jobs.resume", { job: job.id, text: ANSWER }),
            started.invoke("jobs.resume", { job: job.id, text: ANSWER }),
        ]);

        assert.ok(results.some((result) => result.status === "fulfilled"));
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        await waitFor(() => hasReceived(started, ANSWER), "the lead to receive the text");
        assert.equal((await steersOf(started, job.leadConversation)).length, 1);
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
    });
});

describe("jobs.cancel and jobs.complete", () => {
    it("cancels a job whose lead is parked for two running agents, and aborts all three conversations", async () => {
        const started = await start();
        const job = await startedJob(started);
        const invoked = await invokeTwoRunning(started, job.leadConversation);

        const done = await started.invoke<{ status: string; resolution: unknown }>("jobs.cancel", {
            job: job.number,
            justification: "duplicate of C-7",
        });

        assert.equal(done.status, "done");
        assert.deepEqual(done.resolution, { kind: "cancelled", justification: "duplicate of C-7" });
        for (const id of [job.leadConversation, ...invoked]) {
            const meta = await readConversationMeta(started.ctx.host, id);
            assert.equal(meta?.parked, null);
            assert.deepEqual(meta?.awaiting, []);
            await waitFor(() => isIdle(started.ctx, id), "the abort");
        }
        const cancelled = (await historyOf(started, job.id)).filter((entry) => entry.field === "resolution");
        assert.deepEqual(
            cancelled.map((entry) => entry.author),
            [author],
        );
    });

    it("cancels a Blocked job", async () => {
        const started = await start();
        const job = await blockedJob(started);

        await started.invoke("jobs.cancel", { job: job.id, justification: "not needed" });

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.parked, null);
    });

    it("completes an In progress job that has a definition of done, and aborts its conversations", async () => {
        const started = await start();
        const job = await startedJob(started);
        const invoked = await invokeTwoRunning(started, job.leadConversation);

        const done = await started.invoke<{ status: string; resolution: unknown }>("jobs.complete", {
            job: job.id,
            justification: "checked by hand",
        });

        assert.equal(done.status, "done");
        assert.deepEqual(done.resolution, { kind: "completed", justification: "checked by hand" });
        for (const id of [job.leadConversation, ...invoked]) {
            await waitFor(() => isIdle(started.ctx, id), "the abort");
        }
    });

    it("refuses a complete without a definition of done invalid_input naming it, and changes nothing", async () => {
        const started = await start();
        const job = await started.create();
        await startJob(started.deps, job.id);

        const refused = await failure(started.invoke("jobs.complete", { job: job.id, justification: "ok" }));

        assert.equal(refused.code, "invalid_input");
        assert.match(refused.message, /definition of done/);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    for (const justification of ["", "   "]) {
        it(`refuses a cancel with justification ${JSON.stringify(justification)}, naming the field`, async () => {
            const started = await start();
            const job = await startedJob(started);

            const refused = await failure(started.invoke("jobs.cancel", { job: job.id, justification }));

            assert.equal(refused.code, "invalid_input");
            assert.match(refused.message, /justification/);
            assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        });
    }

    it("refuses a cancel that has no justification field invalid_input naming it", async () => {
        const started = await start();
        const job = await startedJob(started);

        const refused = await failure(started.invoke("jobs.cancel", { job: job.id }));

        assert.equal(refused.code, "invalid_input");
        assert.match(refused.message, /justification/);
    });

    it("refuses a job source", async () => {
        const started = await start();
        const job = await startedJob(started);

        const refused = await failure(
            started.invoke(
                "jobs.cancel",
                { job: job.id, justification: "x" },
                { actor: { kind: "job_source", source: "tracker" } },
            ),
        );

        assert.equal(refused.code, "invalid_input");
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });
});

describe("a Done job", () => {
    it("refuses a title update, a worklog entry, a resume, a complete and a cancel, and still relates", async () => {
        const started = await start();
        const job = await startedJob(started);
        const other = await started.create();
        await started.invoke("jobs.cancel", { job: job.id, justification: "done with it" });
        const before = await started.invoke<{ history: unknown[]; worklog: unknown[] }>("jobs.get", { job: job.id });

        const refusals = await Promise.all([
            failure(started.invoke("jobs.update", { job: job.id, title: "new title" })),
            failure(started.invoke("jobs.worklog.add", { job: job.id, text: "note" })),
            failure(started.invoke("jobs.resume", { job: job.id, text: ANSWER })),
            failure(started.invoke("jobs.complete", { job: job.id, justification: "again" })),
            failure(started.invoke("jobs.cancel", { job: job.id, justification: "again" })),
        ]);

        assert.deepEqual(
            refusals.map((refused) => refused.code),
            ["conflict", "conflict", "conflict", "conflict", "conflict"],
        );
        const related = await started.invoke<{ a: { related: string[] } }>("jobs.relate", {
            job: job.id,
            other: other.id,
        });
        assert.equal(related.a.related.length, 1);
        const after = await started.invoke<{ history: unknown[]; worklog: unknown[] }>("jobs.get", { job: job.id });
        assert.equal(after.worklog.length, before.worklog.length);
        assert.equal(after.history.length, before.history.length + 1);
        assert.deepEqual(await steersOf(started, job.leadConversation), []);
    });
});
