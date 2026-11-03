/**
 * The front desk's state and steering tools (S-001 AC-022.1, AC-022.4 to AC-022.6, AC-023.2): the front desk reads
 * what the read operations return and steers the conversations of jobs, as a team member does.
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
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { FRONT_DESK_TOOL_NAMES } from "../../src/desk/desk_model.ts";
import { submissionIdFor } from "../../src/host/conversation_control.ts";
import { createInvokedConversations } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { blockJob, startJob } from "../../src/jobs/job_actions.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const SCRIPT_INPUT = "script";
const HANG_PROMPT = "hang until aborted";
const ANSWER = "the nightly build on ci-2";
const MISSING_ID = "9999";
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const email: Caller = { actor: { kind: "team_member", wayIn: "email" } };

type Call = { name: string; arguments: Record<string, unknown>; id?: string };
type Seen = { text: string; isError: boolean };
type ModelContext = Parameters<FauxResponseFactory>[0];
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

// pi-durable sends the tools as changes on system messages; the tools in effect are the fold of them.
function toolNamesOf(context: ModelContext): string[] {
    const inEffect = new Set<string>();
    for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) inEffect.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) inEffect.delete(tool.name);
    }
    return [...inEffect];
}

const isHangPrompt = (context: ModelContext) =>
    context.messages.some((message) => message.role === "user" && textOf(message.content).includes(HANG_PROMPT));

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let script: Call[] = [];
    let step = 0;
    let seen: Seen[] = [];
    let offered: string[] = [];
    // Only the front desk's run follows the script; a conversation given the hang prompt stays busy until it is
    // aborted; every other conversation answers "done".
    const respond: FauxResponseFactory = async (context, options) => {
        fake.appendResponses([respond]);
        const isScripted = context.messages.some(
            (message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT,
        );
        if (isHangPrompt(context)) {
            await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return fauxAssistantMessage("stopped");
        }
        if (!isScripted) return fauxAssistantMessage("done");
        offered = toolNamesOf(context);
        const results = context.messages.flatMap((message) =>
            message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
        );
        seen = results.slice(results.length - step);
        const call = script[step];
        step += 1;
        if (call === undefined) return fauxAssistantMessage("finished");
        const callOptions = call.id === undefined ? undefined : { id: call.id };
        return fauxAssistantMessage([fauxToolCall(call.name, call.arguments as never, callOptions)], {
            stopReason: "toolUse",
        });
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
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
    let turn = 0;
    // The front desk's model makes `calls` in one run begun by a team member's input.
    async function run(calls: Call[]): Promise<Seen[]> {
        script = calls;
        step = 0;
        turn += 1;
        const input = { conversationId: deskId, content: SCRIPT_INPUT, requestId: `script-${turn}` };
        const { submissionId } = (await invoke("conversations.submit", input)) as { submissionId: string };
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as { state: string };
        assert.equal(waited.state, "done");
        return seen;
    }
    const isIdle = async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false;
    async function createJob(): Promise<CreatedJob> {
        const job = (await invoke("jobs.create", { text: "do it" }, email)) as CreatedJob;
        await until(() => isIdle(job.leadConversation), "the lead's first run to end");
        return job;
    }
    return {
        invoke,
        run,
        deskId,
        ctx,
        createJob,
        isIdle,
        deps: { ctx, options: jobs.options },
        offered: () => offered,
    };
}

const jsonOf = (result: Seen | undefined) => JSON.parse(result?.text ?? "null");
const asStored = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("the front-desk state and steering tools", { timeout: TEST_TIMEOUT_MS }, () => {
    it("offers exactly the front desk's tools and none of the job conversation or file tools", async () => {
        const fixture = await start();

        await fixture.run([]);

        assert.deepEqual([...fixture.offered()].sort(), [...FRONT_DESK_TOOL_NAMES].sort());
        for (const name of [
            "handoff",
            "invoke",
            "steer",
            "block_job",
            "complete_job",
            "read",
            "write",
            "edit",
            "bash",
        ]) {
            assert.ok(!fixture.offered().includes(name), `${name} is not offered`);
        }
    });

    it("places input for the parked lead of a Blocked job as the front desk's steer and resumes the job", async () => {
        const fixture = await start();
        const job = await fixture.createJob();
        await startJob(fixture.deps, job.id);
        await blockJob(fixture.deps, job.id, "which build is failing?", { kind: "daemon" });
        assert.equal((await fixture.ctx.jobStore.getJob(job.id)).status, "blocked");

        const results = await fixture.run([
            {
                name: "send_to_conversation",
                arguments: { conversationId: job.leadConversation, message: ANSWER, mode: "followUp" },
                id: "call-answer",
            },
        ]);

        assert.equal(results[0]?.isError, false);
        await until(
            async () => (await fixture.ctx.jobStore.getJob(job.id)).status === "in_progress",
            "the job to resume",
        );
        const requestId = `steer:${fixture.deskId}:call-answer`;
        assert.ok(await submissionIdFor(fixture.ctx.host, job.leadConversation, requestId), "the input is placed");
        const entries = (await fixture.ctx.host.readEntries(job.leadConversation, { limit: 200 })).entries;
        const steers = entries.filter((entry) => entry.kind === STEER_RECORD_KIND);
        assert.deepEqual(
            steers.map((entry) => (entry.data as { actor: unknown }).actor),
            [{ kind: "agent", conversationId: fixture.deskId, role: "desk" }],
        );
        assert.equal((await readConversationMeta(fixture.ctx.host, job.leadConversation))?.parked, null);
    });

    it("aborts a lead and the invoked agent it awaits, and the front desk's run goes on", async () => {
        const fixture = await start();
        const job = await fixture.createJob();
        const lead = (await readConversationMeta(fixture.ctx.host, job.leadConversation))?.seat;
        assert.ok(lead);
        const [child] = await createInvokedConversations(fixture.ctx.host, {
            invokingId: job.leadConversation,
            callId: "invoke-1",
            agents: [{ seat: lead, contextMode: "clean", jobPrompt: HANG_PROMPT }],
            actor: { kind: "agent", conversationId: job.leadConversation, role: lead.role },
        });
        assert.ok(child);
        await until(async () => !(await fixture.isIdle(child)), "the invoked agent to run");

        const results = await fixture.run([
            { name: "stop_conversation", arguments: { conversationId: job.leadConversation } },
        ]);

        assert.equal(results[0]?.isError, false);
        await until(() => fixture.isIdle(child), "the invoked agent to stop");
        const meta = await readConversationMeta(fixture.ctx.host, job.leadConversation);
        assert.deepEqual(meta?.awaiting, []);
        assert.equal((await fixture.ctx.host.conversationInfo(fixture.deskId))?.busy, false);
    });

    it("returns an error result for a steering tool naming the front desk or a missing conversation", async () => {
        const fixture = await start();

        const results = await fixture.run([
            {
                name: "send_to_conversation",
                arguments: { conversationId: fixture.deskId, message: "hi", mode: "steer" },
            },
            { name: "send_to_conversation", arguments: { conversationId: MISSING_ID, message: "hi", mode: "steer" } },
            { name: "stop_conversation", arguments: { conversationId: fixture.deskId } },
            { name: "stop_conversation", arguments: { conversationId: MISSING_ID } },
        ]);

        assert.equal(results.length, 4);
        assert.deepEqual(
            results.map((result) => result.isError),
            [true, true, true, true],
        );
        assert.match(results[1]?.text ?? "", new RegExp(MISSING_ID));
    });

    it("returns what the read operations return for the same input", async () => {
        const fixture = await start();
        const job = await fixture.createJob();
        const conversationId = job.leadConversation;

        const results = await fixture.run([
            { name: "read_conversation", arguments: { conversationId } },
            { name: "read_entries", arguments: { conversationId, limit: 2 } },
            { name: "read_invocations", arguments: { conversationId } },
            { name: "read_usage", arguments: { conversationId } },
            { name: "read_status", arguments: {} },
            { name: "read_conversation", arguments: { conversationId: MISSING_ID } },
        ]);

        const expected = await Promise.all([
            fixture.invoke("conversations.get", { conversationId }),
            fixture.invoke("conversations.entries", { conversationId, limit: 2 }),
            fixture.invoke("conversations.invocations", { conversationId }),
            fixture.invoke("usage.get", { conversationId }),
        ]);
        for (const [index, value] of expected.entries()) assert.deepEqual(jsonOf(results[index]), asStored(value));
        const status = jsonOf(results[4]);
        const { workerThreads: _expected, ...expectedStatus } = (await fixture.invoke("daemon.status", {})) as Record<
            string,
            unknown
        >;
        const { workerThreads: _seen, ...seenStatus } = status;
        assert.deepEqual(seenStatus, asStored(expectedStatus));
        assert.equal(typeof status.workerThreads.count, "number");
        assert.equal(results[5]?.isError, true);
        assert.match(results[5]?.text ?? "", new RegExp(MISSING_ID));
    });
});
