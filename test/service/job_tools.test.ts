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
import { createJobToolsExtension, JOB_TOOLS_EXTENSION_NAME } from "../../src/jobs/job_tools_extension.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SCRIPT_INPUT = "script";
const quietLogger = createLogger({ stream: { write: () => true } });
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const sourceCaller: Caller = { actor: { kind: "job_source", source: "schedule" } };
const schedule = { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" };
const JOB_TOOLS = [...JOB_TOOL_NAMES];

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Call = { name: string; arguments: Record<string, unknown>; id?: string };
type ToolResultSeen = { text: string; isError: boolean };
type ModelContext = Parameters<FauxResponseFactory>[0];
type CreatedJob = { id: string; number: string; related: string[]; leadConversation: string };
type RunResult = { state: string; results: ToolResultSeen[] };

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

function toolResultsOf(context: ModelContext): ToolResultSeen[] {
    return context.messages.flatMap((message) =>
        message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
    );
}

// Only the conversation a test drives follows the script; the lead conversations that jobs start answer "done".
const isScripted = (context: ModelContext): boolean =>
    context.messages.some((message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT);

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    let script: Call[] = [];
    let lastResults: ToolResultSeen[] = [];
    let step = 0;
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        if (!isScripted(context)) return fauxAssistantMessage("done");
        // The conversation keeps the results of earlier runs; this run's are the last `step` of them.
        const seen = toolResultsOf(context);
        lastResults = seen.slice(seen.length - step);
        const call = script[step];
        step += 1;
        if (call === undefined) return fauxAssistantMessage("finished");
        const options = call.id === undefined ? undefined : { id: call.id };
        return fauxAssistantMessage([fauxToolCall(call.name, call.arguments as never, options)], {
            stopReason: "toolUse",
        });
    };
    fake.setResponses([respond]);
    fakes.push(fake);
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
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const ctx = captured as ServiceContext;
    let turn = 0;
    return {
        ctx,
        invoke: (name: string, input: unknown, as: Caller = webCaller) => daemon.catalogue.invoke(name, input, as),
        async createJob(as: Caller = cliCaller, extra: Record<string, unknown> = {}): Promise<CreatedJob> {
            const input = { text: "renew the certificate", ...extra };
            return (await daemon.catalogue.invoke("jobs.create", input, as)) as CreatedJob;
        },
        // Seats a conversation of the job whose seat lists the job tools, as T-123 will for every role.
        async seat(jobId: string, tools = JOB_TOOLS): Promise<string> {
            const seat = { ...agents.runtime().catalog.seatFor("gp"), tools };
            const { conversationId } = await createSeatedConversation(ctx.host, {
                scope: "job-tools-test",
                key: `${jobId}:${tools.join()}`,
                job: { jobId, isLead: true, origin: { kind: "request", wayIn: "command line" }, depth: 0 },
                seat,
                actor: { kind: "team_member", wayIn: "command line" },
            });
            return conversationId;
        },
        async run(conversationId: string, calls: Call[]): Promise<RunResult> {
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

const jsonOf = (result: ToolResultSeen | undefined) => JSON.parse(result?.text ?? "null");

describe("the job tools extension", () => {
    it("is named intern.jobs and brings the job tools", () => {
        const extension = createJobToolsExtension({} as never);
        assert.equal(JOB_TOOLS_EXTENSION_NAME, "intern.jobs");
        assert.equal(extension.name, JOB_TOOLS_EXTENSION_NAME);
        assert.deepEqual(extension.tools?.map((tool) => tool.name).sort(), [...JOB_TOOLS].sort());
    });
});

describe("read_job", () => {
    it("returns the job of its own conversation with its worklog and history", async () => {
        const started = await start();
        const job = await started.createJob();
        const other = await started.createJob(webCaller);
        await started.invoke("jobs.worklog.add", { job: job.id, text: "checked the expiry" });
        await started.invoke("jobs.worklog.add", { job: other.id, text: "belongs to the other job" });
        const conversation = await started.seat(job.id);

        const { state, results } = await started.run(conversation, [{ name: "read_job", arguments: {} }]);

        assert.equal(state, "done");
        assert.equal(results[0]?.isError, false);
        const read = jsonOf(results[0]);
        assert.equal(read.number, job.number);
        assert.deepEqual(
            read.worklog.map((entry: { text: string }) => entry.text),
            ["checked the expiry"],
        );
        assert.ok(Array.isArray(read.history));
    });
});

describe("add_worklog and update_job", () => {
    it("lists the lead's entry and the team member's entry in order with each author", async () => {
        const started = await start();
        const job = await started.createJob();
        const conversation = await started.seat(job.id);
        const lead = "tried certbot renew: rate limited";
        const member = "use the staging ACME endpoint";

        await started.run(conversation, [{ name: "add_worklog", arguments: { text: lead } }]);
        await started.invoke("jobs.worklog.add", { job: job.number, text: member }, cliCaller);

        const { entries } = (await started.invoke("jobs.worklog.list", { job: job.id })) as {
            entries: { text: string; author: unknown }[];
        };
        assert.deepEqual(
            entries.map((entry) => entry.text),
            [lead, member],
        );
        assert.deepEqual(entries[0]?.author, { kind: "agent", conversationId: conversation, role: "gp" });
        assert.deepEqual(entries[1]?.author, { kind: "team_member", wayIn: "command line" });
    });

    it("records the agent as the author of an edit made with update_job", async () => {
        const started = await start();
        const job = await started.createJob();
        const conversation = await started.seat(job.id);

        const { results } = await started.run(conversation, [
            { name: "update_job", arguments: { title: "Renew the cert", definitionOfDone: "the cert is valid" } },
        ]);

        assert.equal(results[0]?.isError, false);
        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.title, "Renew the cert");
        assert.equal(stored.definitionOfDone, "the cert is valid");
        const { entries } = await started.ctx.jobStore.listHistory(job.id, {});
        const edit = entries.find((entry) => entry.field === "title");
        assert.deepEqual(edit?.author, { kind: "agent", conversationId: conversation, role: "gp" });
    });
});

describe("create_job", () => {
    it("creates an A job from the job and conversation, Related to the job, once per call id", async () => {
        const started = await start();
        const parent = await started.createJob(sourceCaller, { origin: schedule });
        assert.match(parent.number, /^S-/);
        const conversation = await started.seat(parent.id);
        const create = { name: "create_job", arguments: { text: "also rotate the keys" }, id: "call-keys" };

        const first = await started.run(conversation, [create]);
        const created = jsonOf(first.results[0]);

        assert.match(created.number, /^A-\d+$/);
        assert.deepEqual(created.request.origin, {
            kind: "follow_up",
            jobId: parent.id,
            conversationId: conversation,
        });
        assert.deepEqual(created.related, [parent.number]);
        assert.deepEqual((await started.ctx.jobStore.getJob(parent.id)).related, [created.number]);

        const second = await started.run(conversation, [create]);
        assert.equal(jsonOf(second.results[0]).id, created.id);
        const next = await started.run(conversation, [{ ...create, id: "call-other" }]);
        assert.equal(jsonOf(next.results[0]).number, `A-${Number(created.number.slice(2)) + 1}`);
    });
});

describe("relate_jobs", () => {
    it("relates and unrelates its own job and another named by short number", async () => {
        const started = await start();
        const job = await started.createJob();
        const other = await started.createJob(webCaller);
        const conversation = await started.seat(job.id);

        await started.run(conversation, [{ name: "relate_jobs", arguments: { job: other.number } }]);
        assert.deepEqual((await started.ctx.jobStore.getJob(job.id)).related, [other.number]);
        assert.deepEqual((await started.ctx.jobStore.getJob(other.id)).related, [job.number]);

        await started.run(conversation, [{ name: "relate_jobs", arguments: { job: other.id, unrelate: true } }]);
        assert.deepEqual((await started.ctx.jobStore.getJob(job.id)).related, []);
        assert.deepEqual((await started.ctx.jobStore.getJob(other.id)).related, []);
    });
});

describe("a refused job tool", () => {
    it("returns an error result naming the reason and lets the run go on", async () => {
        const started = await start();
        const job = await started.createJob();
        const conversation = await started.seat(job.id);

        const { state, results } = await started.run(conversation, [
            { name: "add_worklog", arguments: { text: "" } },
            { name: "relate_jobs", arguments: { job: "C-999" } },
            { name: "read_job", arguments: {} },
        ]);

        assert.equal(state, "done");
        assert.equal(results.length, 3);
        assert.equal(results[0]?.isError, true);
        assert.match(results[0]?.text ?? "", /worklog/i);
        assert.equal(results[1]?.isError, true);
        assert.match(results[1]?.text ?? "", /C-999/);
        assert.equal(results[2]?.isError, false);
    });

    it("returns an error result for an edit of a Done job", async () => {
        const started = await start();
        const job = await started.createJob();
        const conversation = await started.seat(job.id);
        await started.ctx.jobStore.applyAction(job.id, "cancel", { justification: "not needed" }, { kind: "daemon" });

        const { state, results } = await started.run(conversation, [
            { name: "update_job", arguments: { title: "late" } },
            { name: "add_worklog", arguments: { text: "late note" } },
        ]);

        assert.equal(state, "done");
        for (const result of results) {
            assert.equal(result.isError, true);
            assert.match(result.text, /Done/);
        }
    });
});
