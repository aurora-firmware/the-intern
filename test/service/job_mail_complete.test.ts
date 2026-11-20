/**
 * The `mailText` of `jobs.complete` (S-004 Interfaces, S-009 REQ-015): a team member's completion of a marked email
 * job, with a stub mail policy that owes the reply the text gives, or answers `not_sent` for none.
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
import { startJob } from "../../src/jobs/job_actions.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type MailDecision, type MailPolicy, setMailPolicy } from "../../src/jobs/mail_policy.ts";
import { createJob, type JobView } from "../../src/service/job_operations.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const OBSERVED = { account: "work", messageId: "<m1@example.test>", sender: "ann@example.test" };
const emailCaller: Caller = { actor: { kind: "team_member", wayIn: "email", observed: OBSERVED } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Asked = { action: "complete"; mailText: string | undefined };

// Owes a result reply holding the text the completion gave, and answers `not_sent` for a completion without one.
function stubPolicy(asked: Asked[], jobKey: () => string): MailPolicy {
    return {
        forBlock: async (): Promise<MailDecision> => ({ kind: "none" }),
        forComplete: async ({ mailText }): Promise<MailDecision> => {
            asked.push({ action: "complete", mailText });
            if (mailText === undefined) return { kind: "not_sent" };
            return {
                kind: "owe",
                row: {
                    key: jobKey(),
                    account: "work",
                    kind: "result",
                    recipients: [OBSERVED.sender],
                    subject: "Re: Please look at this",
                    mailText,
                    inReplyTo: OBSERVED.messageId,
                    references: OBSERVED.messageId,
                },
            };
        },
        emailDetails: async () => undefined,
        committed: () => {},
    };
}

async function start() {
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
    const asked: Asked[] = [];
    let key = "";
    setMailPolicy(ctx.host, stubPolicy(asked, () => key));
    return {
        ctx,
        asked,
        invoke: (name: string, input: unknown) => daemon.catalogue.invoke(name, input, cliCaller),
        // A started email job with the request mark and a definition of done.
        async markedEmailJob(id: string): Promise<JobView> {
            const request = {
                text: "Please look at this",
                idempotencyKey: `mail:${id}`,
                email: { account: "work", savedId: id, messageId: OBSERVED.messageId },
            };
            const job = await createJob(ctx, jobs.options, request, emailCaller);
            await ctx.jobStore.updateFields(job.id, { definitionOfDone: "answered" }, { kind: "daemon" });
            await ctx.jobStore.setRequestMark(job.id, true, { kind: "team_member", wayIn: "command line" });
            await startJob({ ctx, options: jobs.options }, job.id);
            key = `result:${job.id}`;
            return job;
        },
    };
}

const mailEntries = async (ctx: ServiceContext, jobId: string) =>
    (await ctx.jobStore.listHistory(jobId, {})).entries.filter((entry) => entry.field === "mail");

describe("jobs.complete with a mail text", () => {
    it("passes the mail text to the completion, and the owed reply holds it", async () => {
        const started = await start();
        const job = await started.markedEmailJob("saved-1");

        await started.invoke("jobs.complete", { job: job.id, justification: "done", mailText: "It is done." });

        assert.deepEqual(started.asked, [{ action: "complete", mailText: "It is done." }]);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
        const row = await started.ctx.jobStore.readMail((tx) => tx.outboxByKey(`result:${job.id}`));
        assert.equal(row?.mailText, "It is done.");
        assert.equal(row?.state, "owed");
    });

    it("refuses a mail text that is not a string as invalid_input and leaves the job unchanged", async () => {
        const started = await start();
        const job = await started.markedEmailJob("saved-2");
        const before = (await started.ctx.jobStore.listHistory(job.id, {})).entries.length;

        await assert.rejects(
            started.invoke("jobs.complete", { job: job.id, justification: "done", mailText: 7 }),
            (error: { code: string }) => error.code === "invalid_input",
        );

        assert.deepEqual(started.asked, []);
        assert.notEqual((await started.ctx.jobStore.getJob(job.id)).status, "done");
        assert.equal((await started.ctx.jobStore.listHistory(job.id, {})).entries.length, before);
    });

    it("completes without a mail text and writes the not_sent history entry", async () => {
        const started = await start();
        const job = await started.markedEmailJob("saved-3");

        await started.invoke("jobs.complete", { job: job.id, justification: "done" });

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
        const entries = await mailEntries(started.ctx, job.id);
        assert.equal(entries.length, 1);
        const detail = entries[0]?.new as { mail: string; text: string };
        assert.equal(detail.mail, "not_sent");
        assert.equal(detail.text, "result reply not sent: no mail text");
    });
});

describe("jobs.cancel on a marked email job", () => {
    it("owes no mail and asks the policy nothing", async () => {
        const started = await start();
        const job = await started.markedEmailJob("saved-4");

        await started.invoke("jobs.cancel", { job: job.id, justification: "no longer needed" });

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
        assert.deepEqual(started.asked, []);
        assert.equal(await started.ctx.jobStore.readMail((tx) => tx.outboxByKey(`result:${job.id}`)), undefined);
        assert.deepEqual(await mailEntries(started.ctx, job.id), []);
    });
});
