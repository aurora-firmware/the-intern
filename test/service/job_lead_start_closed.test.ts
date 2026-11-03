/**
 * A lead start for a Done job (S-004 REQ-007; S-001 REQ-026, AC-026.7, AC-026.8; ADR-001 decision 4): a job cancelled
 * before its lead conversation is created gets none, and one cancelled before the lead's first input gets no first
 * input and a closed lead. `jobs.create` returns the job Done in both cases, with the one cancel in its history.
 */
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
import { hasSubmissionWithRequestId } from "../../src/host/conversation_control.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { cancelJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { leadStartRequestId } from "../../src/service/job_operations.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const teamMember: JobAuthor = { kind: "team_member", wayIn: "command line" };
const CANCEL_JUSTIFICATION = "The team member changed their mind";

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type JobResult = {
    id: string;
    status: string;
    resolution?: { kind: string; justification: string };
    leadConversation?: string;
};

type Started = {
    ctx: ServiceContext;
    create(): Promise<JobResult>;
    get(jobId: string): Promise<JobResult>;
    conversationsOf(jobId: string): Promise<string[]>;
    userInputs(conversationId: string): Promise<string[]>;
};

function newFake(): FauxProviderRegistration {
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    const answer = async () => {
        fake.appendResponses([answer]);
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    fakes.push(fake);
    return fake;
}

async function waitForDaemon(daemon: RunningDaemon): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** Starts a daemon whose jobs component cancels each job as a team member at the write point, when one is named. */
async function start(cancelAt?: WritePoint): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = newFake();
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    let captured: ServiceContext | undefined;
    const cancelOptions = { agents, logger: quietLogger, turnEndRule: false };
    const jobs = await createJobsComponent({
        ...cancelOptions,
        afterWrite: async (point, jobId) => {
            if (point !== cancelAt) return;
            await cancelJob(
                { ctx: captured as ServiceContext, options: cancelOptions },
                jobId,
                CANCEL_JUSTIFICATION,
                teamMember,
            );
        },
    });
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
    await waitForDaemon(daemon);
    const ctx = captured as ServiceContext;
    return {
        ctx,
        create: () => daemon.catalogue.invoke("jobs.create", { text: "plan the release" }, caller) as never,
        get: (jobId) => daemon.catalogue.invoke("jobs.get", { job: jobId }, caller) as never,
        async conversationsOf(jobId) {
            const ofJob: string[] = [];
            for (const { id } of await ctx.host.listConversations()) {
                if ((await readConversationMeta(ctx.host, id))?.jobId === jobId) ofJob.push(id);
            }
            return ofJob;
        },
        async userInputs(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === "pi.user").map((entry) => JSON.stringify(entry.data));
        },
    };
}

async function cancelCount(started: Started, jobId: string): Promise<number> {
    const { entries } = await started.ctx.jobStore.listHistory(jobId, { limit: 100 });
    return entries.filter(
        (entry) => entry.field === "resolution" && (entry.new as { kind?: string }).kind === "cancelled",
    ).length;
}

async function waitForInputs(started: Started, conversationId: string, count: number): Promise<string[]> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const inputs = await started.userInputs(conversationId);
        if (inputs.length >= count || Date.now() > deadline) return inputs;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const SETTLE_MS = 300;

describe("a lead start for a job cancelled before its lead conversation is created", () => {
    it("creates no conversation, and jobs.create returns the job Done with resolution cancelled", async () => {
        const started = await start("job-created");

        const job = await started.create();

        assert.equal(job.status, "done");
        assert.equal(job.resolution?.kind, "cancelled");
        assert.equal(job.resolution?.justification, CANCEL_JUSTIFICATION);
        assert.equal(job.leadConversation, undefined);
        assert.deepEqual(await started.conversationsOf(job.id), []);
    });

    it("leaves jobs.get with no leadConversation for the job", async () => {
        const started = await start("job-created");

        const job = await started.create();

        assert.equal((await started.get(job.id)).leadConversation, undefined);
    });

    it("records exactly one cancel in the job's history", async () => {
        const started = await start("job-created");

        const job = await started.create();

        assert.equal(await cancelCount(started, job.id), 1);
    });
});

describe("a lead start for a job cancelled after its lead conversation is created", () => {
    it("returns from jobs.create the job Done with resolution cancelled and the cancel's justification", async () => {
        const started = await start("lead-created");

        const job = await started.create();

        assert.equal(job.status, "done");
        assert.deepEqual(job.resolution, { kind: "cancelled", justification: CANCEL_JUSTIFICATION });
    });

    it("leaves the lead conversation closed with no submission of the first input", async () => {
        const started = await start("lead-created");

        const job = await started.create();

        const [leadId, ...others] = await started.conversationsOf(job.id);
        assert.ok(leadId !== undefined, "the lead conversation was created");
        assert.deepEqual(others, []);
        assert.equal((await readConversationMeta(started.ctx.host, leadId))?.closed, true);
        assert.equal(await hasSubmissionWithRequestId(started.ctx.host, leadId, leadStartRequestId(job.id)), false);
    });

    it("records exactly one cancel in the job's history", async () => {
        const started = await start("lead-created");

        const job = await started.create();

        assert.equal(await cancelCount(started, job.id), 1);
    });
});

describe("a lead start that isn't interrupted", () => {
    it("creates the lead conversation and submits its first input once", async () => {
        const started = await start();

        const job = await started.create();

        assert.equal(job.status, "to_do");
        assert.ok(job.leadConversation !== undefined, "jobs.create names the lead conversation");
        assert.deepEqual(await started.conversationsOf(job.id), [job.leadConversation]);
        assert.equal(
            await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, leadStartRequestId(job.id)),
            true,
        );
        await waitForInputs(started, job.leadConversation, 1);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const inputs = await started.userInputs(job.leadConversation);
        assert.equal(inputs.length, 1);
        assert.match(inputs[0] ?? "", /plan the release/);
    });
});
