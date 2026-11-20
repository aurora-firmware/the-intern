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
import { blockJob, cancelJob, completeJob, type JobActionDeps } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import {
    type MailDecision,
    type MailPolicy,
    MailTextRequiredError,
    mailPolicyOf,
    type OwedMail,
    setMailPolicy,
} from "../../src/jobs/mail_policy.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
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
    deps: JobActionDeps;
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
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const ctx = captured as ServiceContext;
    return {
        ctx,
        deps: { ctx, options: jobs.options },
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

const owed = (job: { id: string }, key: string): OwedMail => ({
    key,
    account: "work",
    kind: "question",
    recipients: ["ann@example.test"],
    subject: "A question",
    mailText: "Which schema?",
    inReplyTo: "<a@example.test>",
    references: "<a@example.test>",
});

type Stub = { policy: MailPolicy; asked: string[]; committed: { sawRow: boolean }[] };

// A policy that answers with the given decisions, and records, at each `committed()`, whether the row is stored.
function stubPolicy(
    ctx: ServiceContext,
    answers: { block?: MailDecision; complete?: MailDecision },
    key: string,
): Stub {
    const stub: Stub = { asked: [], committed: [], policy: undefined as unknown as MailPolicy };
    stub.policy = {
        forBlock: async ({ mailText }) => {
            stub.asked.push(`block:${mailText}`);
            return answers.block ?? { kind: "none" };
        },
        forComplete: async ({ mailText }) => {
            stub.asked.push(`complete:${mailText}`);
            return answers.complete ?? { kind: "none" };
        },
        emailDetails: async () => undefined,
        committed: () => {
            stub.committed.push({ sawRow: false });
            const entry = stub.committed[stub.committed.length - 1] as { sawRow: boolean };
            void ctx.jobStore
                .readMail((tx) => tx.outboxByKey(key))
                .then((row) => {
                    entry.sawRow = row !== undefined;
                });
        },
    };
    return stub;
}

const mailEntries = async (ctx: ServiceContext, jobId: string) =>
    (await ctx.jobStore.listHistory(jobId, {})).entries.filter((entry) => entry.field === "mail");

describe("the mail policy asked by block and complete", () => {
    it("blocks, completes and cancels as before while no policy is registered", async () => {
        const started = await start();
        assert.equal(mailPolicyOf(started.ctx.host), undefined);
        const blocked = await started.create();
        assert.equal((await blockJob(started.deps, blocked.id, "stuck", author, "ignored")).status, "blocked");
        assert.equal((await cancelJob(started.deps, blocked.id, "no longer needed", author)).status, "done");
        const finished = await started.create();
        assert.equal((await completeJob(started.deps, finished.id, "done", author, undefined, "text")).status, "done");
        assert.deepEqual(await mailEntries(started.ctx, finished.id), []);
        assert.equal(await started.ctx.jobStore.readMail((tx) => tx.outboxByKey("question:x:1")), undefined);
    });

    it("inserts the owed row of a block in the status change and calls committed after the commit", async () => {
        const started = await start();
        const job = await started.create();
        const key = `question:${job.id}:1`;
        const stub = stubPolicy(started.ctx, { block: { kind: "owe", row: owed(job, key) } }, key);
        setMailPolicy(started.ctx.host, stub.policy);

        const blocked = await blockJob(started.deps, job.id, "stuck", author, "Which schema?");

        assert.equal(blocked.status, "blocked");
        assert.deepEqual(stub.asked, ["block:Which schema?"]);
        const row = await started.ctx.jobStore.readMail((tx) => tx.outboxByKey(key));
        assert.equal(row?.job, job.id);
        assert.equal(row?.state, "owed");
        assert.equal(row?.kind, "question");
        assert.deepEqual(row?.recipients, ["ann@example.test"]);
        assert.equal(row?.mailText, "Which schema?");
        await waitFor(async () => stub.committed.length === 1 && stub.committed[0]?.sawRow === true, "committed()");
    });

    it("inserts the owed row of a completion and calls committed after the commit", async () => {
        const started = await start();
        const job = await started.create();
        const key = `result:${job.id}`;
        const row = { ...owed(job, key), kind: "result" as const, mailText: "All done" };
        const stub = stubPolicy(started.ctx, { complete: { kind: "owe", row } }, key);
        setMailPolicy(started.ctx.host, stub.policy);

        const done = await completeJob(started.deps, job.id, "finished", author, undefined, "All done");

        assert.equal(done.status, "done");
        assert.deepEqual(stub.asked, ["complete:All done"]);
        const stored = await started.ctx.jobStore.readMail((tx) => tx.outboxByKey(key));
        assert.equal(stored?.kind, "result");
        await waitFor(async () => stub.committed.length === 1 && stub.committed[0]?.sawRow === true, "committed()");
    });

    it("throws MailTextRequiredError and writes nothing when the policy requires mail text", async () => {
        const started = await start();
        const job = await started.create();
        const stub = stubPolicy(
            started.ctx,
            { block: { kind: "mail_text_required" }, complete: { kind: "mail_text_required" } },
            "k",
        );
        setMailPolicy(started.ctx.host, stub.policy);
        const before = (await started.ctx.jobStore.listHistory(job.id, {})).entries.length;

        await assert.rejects(blockJob(started.deps, job.id, "stuck", author), MailTextRequiredError);
        await assert.rejects(completeJob(started.deps, job.id, "finished", author), MailTextRequiredError);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await started.ctx.jobStore.listHistory(job.id, {})).entries.length, before);
        assert.deepEqual(stub.committed, []);
    });

    it("writes the not_sent entry in the completion's transaction", async () => {
        const started = await start();
        const job = await started.create();
        const stub = stubPolicy(started.ctx, { complete: { kind: "not_sent" } }, "k");
        setMailPolicy(started.ctx.host, stub.policy);

        await completeJob(started.deps, job.id, "finished", author);

        const entries = await mailEntries(started.ctx, job.id);
        assert.equal(entries.length, 1);
        const detail = entries[0]?.new as { mail: string; text: string };
        assert.equal(detail.mail, "not_sent");
        assert.equal(detail.text, "result reply not sent: no mail text");
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
        assert.deepEqual(stub.committed, []);
    });

    it("writes neither the status change nor the owed row when the job store write fails", async () => {
        const started = await start();
        const job = await started.create();
        const key = `question:${job.id}:1`;
        await started.ctx.jobStore.writeMail((tx) => tx.insertOutbox({ ...owed(job, key), job: job.id }));
        const stub = stubPolicy(started.ctx, { block: { kind: "owe", row: owed(job, key) } }, key);
        setMailPolicy(started.ctx.host, stub.policy);
        const before = (await started.ctx.jobStore.listHistory(job.id, {})).entries.length;

        await assert.rejects(blockJob(started.deps, job.id, "stuck", author, "Which schema?"));

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await started.ctx.jobStore.listHistory(job.id, {})).entries.length, before);
        assert.deepEqual(stub.committed, []);
    });

    it("asks the policy nothing when a job is cancelled", async () => {
        const started = await start();
        const job = await started.create();
        const stub = stubPolicy(started.ctx, { complete: { kind: "mail_text_required" } }, "k");
        setMailPolicy(started.ctx.host, stub.policy);

        assert.equal((await cancelJob(started.deps, job.id, "no longer needed", author)).status, "done");
        assert.deepEqual(stub.asked, []);
    });
});
