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
import type { InstanceDelta, InstanceSnapshot } from "../../src/feed/instance_feed.ts";
import type { Subscription } from "../../src/feed/observation_feed.ts";
import { blockJob, completeJob, type JobActionDeps, resumeJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
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

type Sub = Subscription<InstanceSnapshot, InstanceDelta>;
type CreatedJob = { id: string; number: string; leadConversation: string };
type Started = {
    ctx: ServiceContext;
    deps: JobActionDeps;
    invoke(name: string, input: unknown): Promise<unknown>;
    create(): Promise<CreatedJob>;
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
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
    fakes.push(fake);
    const answer = async () => {
        fake.appendResponses([answer]);
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
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller);
    return {
        ctx,
        deps: { ctx, options: jobs.options },
        invoke,
        async create() {
            const job = (await invoke("jobs.create", { text: "do it" })) as CreatedJob;
            await waitFor(async () => (await ctx.host.conversationInfo(job.leadConversation))?.busy === false, "idle");
            return job;
        },
    };
}

async function next(subscription: Sub): Promise<InstanceDelta> {
    const result = await Promise.race([
        subscription.next(),
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out waiting for a delta")), WAIT_MS),
        ),
    ]);
    assert.ok("delta" in result, "the subscription stays open");
    return result.delta;
}

async function until(subscription: Sub, isDone: (delta: InstanceDelta) => boolean): Promise<InstanceDelta[]> {
    const deltas: InstanceDelta[] = [];
    do deltas.push(await next(subscription));
    while (!isDone(deltas[deltas.length - 1] as InstanceDelta));
    return deltas;
}

const isJobDelta = (delta: InstanceDelta) => delta.type.startsWith("job_");

describe("the instance feed's jobs", () => {
    it("carries every job that isn't Done in the snapshot, with its short number, title and status", async () => {
        const started = await start();
        const open = await started.create();
        const done = await started.create();
        await started.invoke("jobs.update", { job: open.id, title: "Open one" });
        await started.invoke("jobs.update", { job: done.id, definitionOfDone: "it ends" });
        await completeJob(started.deps, done.id, "finished", author);

        const subscription = started.ctx.instanceFeed.subscribe();

        assert.deepEqual(subscription.snapshot.jobs, [
            { number: open.number, title: "Open one", status: "in_progress" },
        ]);
        subscription.close();
    });

    it("publishes a job's life as job deltas in order, numbered in the sequence of the other deltas", async () => {
        const started = await start();
        const subscription = started.ctx.instanceFeed.subscribe();
        const job = (await started.invoke("jobs.create", { text: "do it" })) as CreatedJob;

        const first = await until(subscription, (d) => d.type === "job_status_changed" && d.new === "in_progress");
        await started.invoke("jobs.update", { job: job.id, title: "Renamed", definitionOfDone: "it ends" });
        await blockJob(started.deps, job.id, BLOCKED_REASON, author);
        await resumeJob(started.deps, job.id, author);
        await completeJob(started.deps, job.id, "finished", author);
        const rest = await until(subscription, (d) => d.type === "job_done");

        const all = [...first, ...rest];
        assert.deepEqual(
            all.map((d) => d.seq),
            all.map((_, i) => i + 1),
            "one sequence for every delta of the scope",
        );
        const jobDeltas = all.filter(isJobDelta);
        const { number } = job;
        const [created, ...others] = jobDeltas;
        assert.equal(created?.type, "job_created");
        const createdJob = (created as { job: Record<string, unknown> }).job;
        assert.equal(createdJob.number, number);
        assert.ok(!("worklog" in createdJob) && !("history" in createdJob), "no worklog and no history");
        assert.deepEqual(
            others.map(({ seq: _seq, ...body }) => body),
            [
                { type: "job_status_changed", number, old: "to_do", new: "in_progress" },
                { type: "job_changed", number, fields: { title: "Renamed", definitionOfDone: "it ends" } },
                {
                    type: "job_status_changed",
                    number,
                    old: "in_progress",
                    new: "blocked",
                    blockedReason: BLOCKED_REASON,
                },
                { type: "job_status_changed", number, old: "blocked", new: "in_progress" },
                { type: "job_done", number, resolution: { kind: "completed", justification: "finished" } },
            ],
        );
        subscription.close();
    });

    it("publishes job_worklog_added with the short number and the entry", async () => {
        const started = await start();
        const job = await started.create();
        const subscription = started.ctx.instanceFeed.subscribe();

        const entry = await started.invoke("jobs.worklog.add", { job: job.id, text: "looked at it" });

        assert.deepEqual(await next(subscription), { seq: 1, type: "job_worklog_added", number: job.number, entry });
        subscription.close();
    });

    it("publishes nothing for a refused job write, and the next delta follows in sequence", async () => {
        const started = await start();
        const job = await started.create();
        const subscription = started.ctx.instanceFeed.subscribe();

        await assert.rejects(started.ctx.jobStore.applyAction(job.id, "resume", {}, author));
        await started.invoke("jobs.worklog.add", { job: job.id, text: "after" });

        const delta = await next(subscription);
        assert.equal(delta.type, "job_worklog_added");
        assert.equal(delta.seq, 1);
        subscription.close();
    });

    it("publishes nothing when a Related link changes", async () => {
        const started = await start();
        const a = await started.create();
        const b = await started.create();
        const subscription = started.ctx.instanceFeed.subscribe();

        await started.ctx.jobStore.relate(a.id, b.id, author);
        await started.invoke("jobs.worklog.add", { job: a.id, text: "marker" });

        assert.equal((await next(subscription)).type, "job_worklog_added");
        subscription.close();
    });
});
