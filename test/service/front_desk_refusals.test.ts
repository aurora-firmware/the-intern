/**
 * The front desk is not a job conversation (S-001 REQ-025, S-004 REQ-022): the capability that aborts the conversations
 * of a job and the job operations refuse its conversation id, and ending a job or the front desk's turn leaves the
 * front desk alone.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { submissionIdFor } from "../../src/host/conversation_control.ts";
import { abortJobConversations, FrontDeskNotJobError } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { startJob } from "../../src/jobs/job_actions.ts";
import { reminderRequestId } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { checkTurnEnd, REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const HANG_PROMPT = "hang until aborted";
const NOT_A_JOB = /not a job conversation/;
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const email: Caller = { actor: { kind: "team_member", wayIn: "email" } };

type CreatedJob = { id: string; number: string; leadConversation: string };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

async function start(options: { turnEndRule: boolean }) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    // A conversation given the hang prompt stays busy until it is aborted; every other one answers "done".
    const respond: FauxResponseFactory = async (context, signalOptions) => {
        fake.appendResponses([respond]);
        const isHang = context.messages.some(
            (message) => message.role === "user" && textOf(message.content).includes(HANG_PROMPT),
        );
        if (isHang) {
            await new Promise<void>((resolve) => {
                if (signalOptions?.signal?.aborted) resolve();
                signalOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return fauxAssistantMessage("stopped");
        }
        return fauxAssistantMessage("done");
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: options.turnEndRule });
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [
            agents.component,
            jobs.component,
            desk.component,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations],
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation, "the fake model's api is registered");
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
    await until(() => daemon.phase() === "ready", "the daemon to be ready");
    const ctx = captured as ServiceContext;
    const invoke = (name: string, input: unknown, caller: Caller = commandLine) =>
        daemon.catalogue.invoke(name, input, caller);
    const deskId = ((await invoke("desk.get", {})) as { conversationId: string }).conversationId;
    const isIdle = async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false;
    async function createJob(): Promise<CreatedJob> {
        const job = (await invoke("jobs.create", { text: "do it" }, email)) as CreatedJob;
        await until(() => isIdle(job.leadConversation), "the lead's first run to end");
        await startJob({ ctx, options: jobs.options }, job.id);
        return job;
    }
    async function submitToDesk(content: string, requestId: string): Promise<string> {
        const input = { conversationId: deskId, content, requestId };
        const { submissionId } = (await invoke("conversations.submit", input)) as { submissionId: string };
        return submissionId;
    }
    const deskEntries = async () => (await ctx.host.readEntries(deskId, { limit: 500 })).entries;
    return { invoke, ctx, options: jobs.options, deskId, isIdle, createJob, submitToDesk, deskEntries };
}

const isNotAJobRefusal = (error: unknown) =>
    error instanceof ServiceError && error.code === "invalid_input" && NOT_A_JOB.test(error.message);

describe("the front desk is not a job conversation", { timeout: TEST_TIMEOUT_MS }, () => {
    it("refuses to abort the conversations of a job named by the front desk's id and aborts nothing", async () => {
        const fixture = await start({ turnEndRule: false });
        await fixture.submitToDesk(HANG_PROMPT, "hang-1");
        await until(async () => !(await fixture.isIdle(fixture.deskId)), "the front desk's run to begin");

        await assert.rejects(
            abortJobConversations(fixture.ctx.host, fixture.deskId),
            (error) => error instanceof FrontDeskNotJobError && NOT_A_JOB.test(error.message),
        );

        assert.equal(await fixture.isIdle(fixture.deskId), false);
    });

    for (const [operation, input] of [
        ["jobs.get", {}],
        ["jobs.worklog.list", {}],
        ["jobs.history.list", {}],
        ["jobs.update", { title: "new" }],
        ["jobs.worklog.add", { text: "note" }],
        ["jobs.resume", {}],
        ["jobs.complete", { justification: "done" }],
        ["jobs.cancel", { justification: "stop" }],
    ] as const) {
        it(`refuses ${operation} naming the front desk's id as the job and changes nothing`, async () => {
            const fixture = await start({ turnEndRule: false });
            const job = await fixture.createJob();
            const before = JSON.stringify(await fixture.invoke("jobs.get", { job: job.id }));

            await assert.rejects(fixture.invoke(operation, { job: fixture.deskId, ...input }), isNotAJobRefusal);

            assert.equal(JSON.stringify(await fixture.invoke("jobs.get", { job: job.id })), before);
            assert.equal(((await fixture.invoke("jobs.list", {})) as { jobs: unknown[] }).jobs.length, 1);
        });
    }

    for (const operation of ["jobs.relate", "jobs.unrelate"] as const) {
        it(`refuses ${operation} naming the front desk's id as either job and changes nothing`, async () => {
            const fixture = await start({ turnEndRule: false });
            const job = await fixture.createJob();
            const before = JSON.stringify(await fixture.invoke("jobs.get", { job: job.id }));

            await assert.rejects(fixture.invoke(operation, { job: fixture.deskId, other: job.id }), isNotAJobRefusal);
            await assert.rejects(fixture.invoke(operation, { job: job.id, other: fixture.deskId }), isNotAJobRefusal);

            assert.equal(JSON.stringify(await fixture.invoke("jobs.get", { job: job.id })), before);
        });
    }

    it("lets the front desk's run go on with its entries unchanged while one job is cancelled and another completed", async () => {
        const fixture = await start({ turnEndRule: false });
        const first = await fixture.createJob();
        const second = await fixture.createJob();
        await fixture.submitToDesk(HANG_PROMPT, "hang-1");
        await until(async () => !(await fixture.isIdle(fixture.deskId)), "the front desk's run to begin");
        // The run writes its opening entries after it becomes busy; the hanging model call is the steady state.
        await until(
            async () => (await fixture.deskEntries()).some((entry) => entry.kind === "pi.system"),
            "the front desk's run to reach the model",
        );
        const entriesBefore = JSON.stringify(await fixture.deskEntries());

        await fixture.invoke("jobs.cancel", { job: first.id, justification: "not needed" });
        await fixture.invoke("jobs.update", { job: second.id, definitionOfDone: "it is done" });
        await fixture.invoke("jobs.complete", { job: second.id, justification: "finished" });

        assert.equal(await fixture.isIdle(fixture.deskId), false);
        assert.equal(JSON.stringify(await fixture.deskEntries()), entriesBefore);
        const deskMeta = await readConversationMeta(fixture.ctx.host, fixture.deskId);
        assert.ok(deskMeta, "the front desk has its conversation document");
        assert.notEqual(deskMeta.closed, true);
    });

    it("sends the front desk no reminder at the end of its turn and changes no job", async () => {
        const fixture = await start({ turnEndRule: true });
        const job = (await fixture.invoke("jobs.create", { text: "do it" }, email)) as CreatedJob;
        await until(() => fixture.isIdle(job.leadConversation), "the lead's first run to end");
        const historyBefore = JSON.stringify(await fixture.invoke("jobs.history.list", { job: job.id }));
        const submissionId = await fixture.submitToDesk("hello", "hello-1");
        const waited = (await fixture.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as {
            state: string;
        };
        assert.equal(waited.state, "done");
        await until(() => fixture.isIdle(fixture.deskId), "the front desk to be idle");

        // The rule acts on the desk's id as it would on a job, and finds nothing to remind.
        await checkTurnEnd({ ctx: fixture.ctx, options: fixture.options }, fixture.deskId, fixture.deskId);
        await sleep(200);

        assert.equal(JSON.stringify(await fixture.deskEntries()).includes(REMINDER_TEXT), false);
        for (const n of [0, 1]) {
            const requestId = reminderRequestId(fixture.deskId, n);
            assert.equal(await submissionIdFor(fixture.ctx.host, fixture.deskId, requestId), undefined);
        }
        assert.equal(await fixture.isIdle(fixture.deskId), true);
        assert.equal(JSON.stringify(await fixture.invoke("jobs.history.list", { job: job.id })), historyBefore);
    });
});
