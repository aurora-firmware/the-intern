/**
 * What `jobs.get` returns of a job's email (S-004 REQ-014, Interfaces): the email details the mail policy builds for a
 * job that came by email, and its request mark. A job that didn't come by email has neither, and a daemon without a
 * mail policy still reads every job.
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
import type { Job } from "../../src/jobs/job_store.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type JobEmail, type MailPolicy, setMailPolicy } from "../../src/jobs/mail_policy.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const DETAILS: JobEmail = {
    account: "work",
    sender: "ann@example.test",
    subject: "Please look at this",
    message: { path: "/mail/work/saved-1/message.eml", attachments: ["/mail/work/saved-1/a.pdf"] },
    thread: [
        {
            direction: "received",
            sender: "ann@example.test",
            recipients: ["bob@example.test"],
            subject: "Please look at this",
            date: "2026-11-19T10:00:00.000Z",
        },
    ],
};

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Started = {
    ctx: ServiceContext;
    get(job: string): Promise<Job & { email?: JobEmail }>;
    seedEmailJob(): Promise<Job>;
    seedRequestJob(): Promise<Job>;
};

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
        get: (job) => daemon.catalogue.invoke("jobs.get", { job }, webCaller) as never,
        async seedEmailJob() {
            const origin = { kind: "request", wayIn: "email" } as const;
            const email = { account: "work", savedId: "saved-1", messageId: "<m1@example.test>" };
            return (await ctx.jobStore.insertJob({ letter: "E", requestText: "mail", origin, email, leadStart: {} }))
                .job;
        },
        async seedRequestJob() {
            const origin = { kind: "request", wayIn: "web interface" } as const;
            return (await ctx.jobStore.insertJob({ letter: "W", requestText: "typed", origin, leadStart: {} })).job;
        },
    };
}

function stubPolicy(asked: string[]): MailPolicy {
    return {
        forBlock: async () => ({ kind: "none" }),
        forComplete: async () => ({ kind: "none" }),
        emailDetails: async (job) => {
            asked.push(job.id);
            return DETAILS;
        },
        committed: () => {},
    };
}

describe("jobs.get for a job's email", () => {
    it("returns the details the mail policy builds and the request mark for a job that came by email", async () => {
        const started = await start();
        const asked: string[] = [];
        setMailPolicy(started.ctx.host, stubPolicy(asked));
        const job = await started.seedEmailJob();

        const read = await started.get(job.number);

        assert.deepEqual(read.email, DETAILS);
        assert.equal(read.requestMark, "false");
        assert.deepEqual(asked, [job.id]);
    });

    it("returns neither email nor requestMark for a job that didn't come by email", async () => {
        const started = await start();
        const asked: string[] = [];
        setMailPolicy(started.ctx.host, stubPolicy(asked));
        const job = await started.seedRequestJob();

        const read = await started.get(job.number);

        assert.equal("email" in read, false);
        assert.equal("requestMark" in read, false);
        assert.deepEqual(asked, []);
    });

    it("returns no email details and still succeeds while no mail policy is registered", async () => {
        const started = await start();
        const job = await started.seedEmailJob();

        const read = await started.get(job.number);

        assert.equal(read.id, job.id);
        assert.equal("email" in read, false);
    });
});
