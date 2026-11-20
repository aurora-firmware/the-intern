/**
 * The job tools of Email (S-004 REQ-013, S-009 REQ-008, REQ-014, REQ-015): `mark_request`, and the `mailText` of
 * `block_job` and `complete_job`, on the fake model with a stub mail policy.
 */
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
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import { createJobsComponent, type JobsComponentOptions } from "../../src/jobs/jobs_component.ts";
import { type MailDecision, type MailPolicy, setMailPolicy } from "../../src/jobs/mail_policy.ts";
import { createJob, type JobView } from "../../src/service/job_operations.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const SCRIPT_INPUT = "script";
const quietLogger = createLogger({ stream: { write: () => true } });
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const OBSERVED = { account: "work", messageId: "<m3@example.test>", sender: "ann@example.test" };
const emailCaller: Caller = { actor: { kind: "team_member", wayIn: "email", observed: OBSERVED } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Call = { name: string; arguments: Record<string, unknown> };
type ToolResultSeen = { text: string; isError: boolean };
type ModelContext = Parameters<FauxResponseFactory>[0];

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

const toolResultsOf = (context: ModelContext): ToolResultSeen[] =>
    context.messages.flatMap((message) =>
        message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
    );

// Only the conversation a test drives follows the script; the lead conversations that jobs start answer "done".
const isScripted = (context: ModelContext): boolean =>
    context.messages.some((message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT);

// A policy that requires a mail text of every block and complete, and asks no mail of it.
const REQUIRING: MailPolicy = {
    forBlock: async ({ mailText }): Promise<MailDecision> =>
        mailText === undefined ? { kind: "mail_text_required" } : { kind: "none" },
    forComplete: async ({ mailText }): Promise<MailDecision> =>
        mailText === undefined ? { kind: "mail_text_required" } : { kind: "none" },
    emailDetails: async () => undefined,
    committed: () => {},
};

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    let script: Call[] = [];
    let lastResults: ToolResultSeen[] = [];
    let step = 0;
    let beforeFirstCall: (() => Promise<void>) | undefined;
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        if (!isScripted(context)) return fauxAssistantMessage("done");
        const seen = toolResultsOf(context);
        lastResults = seen.slice(seen.length - step);
        if (step === 0) await beforeFirstCall?.();
        const next = script[step];
        step += 1;
        if (next === undefined) return fauxAssistantMessage("finished");
        return fauxAssistantMessage([fauxToolCall(next.name, next.arguments as never)], { stopReason: "toolUse" });
    };
    fake.setResponses([respond]);
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
    const options: JobsComponentOptions = jobs.options;
    let turn = 0;
    return {
        ctx,
        invoke: (name: string, input: unknown) => daemon.catalogue.invoke(name, input, cliCaller),
        async emailJob(id: string): Promise<JobView> {
            const request = {
                text: "Please look at this",
                idempotencyKey: `mail:${id}`,
                email: { account: "work", savedId: id, messageId: OBSERVED.messageId },
            };
            return createJob(ctx, options, request, emailCaller);
        },
        async cliJob(): Promise<JobView> {
            return (await daemon.catalogue.invoke("jobs.create", { text: "renew it" }, cliCaller)) as JobView;
        },
        // Seats a conversation of the job whose seat lists the job tools: the lead's, or an invoked agent's.
        async seat(jobId: string, isLead: boolean): Promise<string> {
            const seat = { ...agents.runtime().catalog.seatFor("gp"), tools: [...JOB_TOOL_NAMES] };
            const { conversationId } = await createSeatedConversation(ctx.host, {
                scope: "job-mail-tools-test",
                key: `${jobId}:${isLead}`,
                job: {
                    jobId,
                    isLead,
                    origin: { kind: "request", wayIn: "command line" },
                    depth: isLead ? 0 : 1,
                },
                seat,
                actor: { kind: "team_member", wayIn: "command line" },
            });
            return conversationId;
        },
        // A conversation of a Done job takes no input, so a test that needs a run on a Done job ends the job in
        // `beforeFirstCall`, after the input was admitted and before the model's first reply.
        async run(
            conversationId: string,
            calls: Call[],
            beforeFirst?: () => Promise<void>,
        ): Promise<{ state: string; results: ToolResultSeen[] }> {
            beforeFirstCall = beforeFirst;
            script = calls;
            step = 0;
            turn += 1;
            const submission = await submitInput(ctx.host, conversationId, {
                content: SCRIPT_INPUT,
                requestId: `script-${turn}`,
                busyMode: "reject",
            });
            const outcome = await waitForSubmission(ctx.host, submission.submissionId, WAIT_MS);
            return { state: outcome.state, results: lastResults };
        },
    };
}

// The job's own lead runs on its own, so a test compares the request mark's entries, not the whole history.
const markEntries = async (ctx: ServiceContext, jobId: string) =>
    (await ctx.jobStore.listHistory(jobId, {})).entries.filter((entry) => entry.field === "requestMark");

describe("mark_request", () => {
    it("sets the request mark of the email job's lead, writes a requestMark entry and shows in jobs.get", async () => {
        const started = await start();
        const job = await started.emailJob("saved-1");
        const lead = await started.seat(job.id, true);

        const { results } = await started.run(lead, [{ name: "mark_request", arguments: { marked: true } }]);

        assert.equal(results[0]?.isError, false, results[0]?.text);
        const shown = (await started.invoke("jobs.get", { job: job.id })) as {
            requestMark?: string;
            history: { field: string; old: unknown; new: unknown; author: { kind: string } }[];
        };
        assert.equal(shown.requestMark, "true");
        const entry = shown.history.find((item) => item.field === "requestMark");
        assert.deepEqual([entry?.old, entry?.new, entry?.author.kind], ["false", "true", "agent"]);
    });

    it("clears the request mark when called with false", async () => {
        const started = await start();
        const job = await started.emailJob("saved-2");
        const lead = await started.seat(job.id, true);

        await started.run(lead, [
            { name: "mark_request", arguments: { marked: true } },
            { name: "mark_request", arguments: { marked: false } },
        ]);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).requestMark, "false");
        assert.deepEqual(
            (await markEntries(started.ctx, job.id)).map((entry) => entry.new),
            ["true", "false"],
        );
    });

    it("refuses the lead of a command-line job and an agent invoked in the email job, and changes neither", async () => {
        const started = await start();
        const cli = await started.cliJob();
        const email = await started.emailJob("saved-3");
        const cliLead = await started.seat(cli.id, true);
        const invoked = await started.seat(email.id, false);

        const asCliLead = await started.run(cliLead, [{ name: "mark_request", arguments: { marked: true } }]);
        const asInvoked = await started.run(invoked, [{ name: "mark_request", arguments: { marked: true } }]);

        assert.equal(asCliLead.results[0]?.isError, true);
        assert.match(asCliLead.results[0]?.text ?? "", /email/);
        assert.equal(asInvoked.results[0]?.isError, true);
        assert.match(asInvoked.results[0]?.text ?? "", /lead/);
        assert.equal((await started.ctx.jobStore.getJob(cli.id)).requestMark, undefined);
        assert.equal((await started.ctx.jobStore.getJob(email.id)).requestMark, "false");
        assert.deepEqual(await markEntries(started.ctx, cli.id), []);
        assert.deepEqual(await markEntries(started.ctx, email.id), []);
    });

    it("refuses a Done job", async () => {
        const started = await start();
        const job = await started.emailJob("saved-4");
        const lead = await started.seat(job.id, true);
        const cancel = async () => {
            await started.ctx.jobStore.applyAction(job.id, "cancel", { justification: "no" }, { kind: "daemon" });
        };

        const { results } = await started.run(lead, [{ name: "mark_request", arguments: { marked: true } }], cancel);

        assert.equal(results[0]?.isError, true);
        assert.match(results[0]?.text ?? "", /Done/);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).requestMark, "false");
    });

    it("is refused by the job store for a Done job, which keeps its mark and history", async () => {
        const started = await start();
        const job = await started.emailJob("saved-8");
        await started.ctx.jobStore.applyAction(job.id, "cancel", { justification: "no" }, { kind: "daemon" });

        await assert.rejects(() => started.ctx.jobStore.setRequestMark(job.id, true, { kind: "daemon" }), /Done/);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).requestMark, "false");
        assert.deepEqual(await markEntries(started.ctx, job.id), []);
    });
});

describe("complete_job and block_job with a mail text", () => {
    it("refuses complete_job without a mail text, then completes with one", async () => {
        const started = await start();
        setMailPolicy(started.ctx.host, REQUIRING);
        const job = await started.emailJob("saved-5");
        await started.ctx.jobStore.updateFields(job.id, { definitionOfDone: "answered" }, { kind: "daemon" });
        const lead = await started.seat(job.id, true);

        const refused = await started.run(lead, [{ name: "complete_job", arguments: { justification: "all done" } }]);
        assert.equal(refused.results[0]?.isError, true);
        assert.match(refused.results[0]?.text ?? "", /mail text/);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");

        await started.run(lead, [
            { name: "complete_job", arguments: { justification: "all done", mailText: "It is done." } },
        ]);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "done");
    });

    it("refuses block_job without a mail text and the job stays In progress", async () => {
        const started = await start();
        setMailPolicy(started.ctx.host, REQUIRING);
        const job = await started.emailJob("saved-6");
        const lead = await started.seat(job.id, true);

        const { results } = await started.run(lead, [{ name: "block_job", arguments: { reason: "need an answer" } }]);

        assert.equal(results[0]?.isError, true);
        assert.match(results[0]?.text ?? "", /mail text/);
        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "in_progress");
    });

    it("blocks with a mail text", async () => {
        const started = await start();
        setMailPolicy(started.ctx.host, REQUIRING);
        const job = await started.emailJob("saved-7");
        const lead = await started.seat(job.id, true);

        await started.run(lead, [
            { name: "block_job", arguments: { reason: "need an answer", mailText: "Which schema?" } },
        ]);

        assert.equal((await started.ctx.jobStore.getJob(job.id)).status, "blocked");
    });
});
