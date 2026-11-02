import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createSeatedConversation, readConversationMeta, SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { LEAD_DUTY } from "../../src/prompt/role_prompt.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_MS = 400;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "cli" } };
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const requestOrigin = { kind: "request", wayIn: "cli" } as const;

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
    number: string;
    status: string;
    statedBy?: string;
    request: { text: string; origin: unknown };
    resolution?: { kind: string; justification: string };
    leadConversation?: string;
};
type AfterWrite = (point: WritePoint, jobId: string) => void | Promise<void>;

type Started = {
    ctx: ServiceContext;
    provider: string;
    startLead(input: Record<string, unknown>, as?: Caller): Promise<{ conversationId: string; created: boolean }>;
    create(input: Record<string, unknown>, as?: Caller): Promise<JobResult>;
    invoke(name: string, input: unknown): Promise<unknown>;
    folder(name: string): Promise<string>;
    seatConversation(slot?: { scope: string; key: string }): Promise<string>;
    answerCount(conversationId: string): Promise<number>;
    userInputs(conversationId: string): Promise<string[]>;
    seatRecords(conversationId: string): Promise<unknown[]>;
    conversationCount(): Promise<number>;
};

async function start(afterWrite?: (started: Started) => AfterWrite): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({
        models: [
            { id: "model-one", reasoning: true },
            { id: "model-two", reasoning: true },
        ],
    });
    const answer = async () => {
        fake.appendResponses([answer]);
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    let started: Started | undefined;
    const jobs = await createJobsComponent({
        agents,
        logger: quietLogger,
        turnEndRule: false,
        ...(afterWrite && { afterWrite: (point, jobId) => afterWrite(started as Started)(point, jobId) }),
    });
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
    started = {
        ctx,
        provider,
        create: (input, as = caller) => daemon.catalogue.invoke("jobs.create", input, as) as never,
        invoke: (name, input) => daemon.catalogue.invoke(name, input, caller),
        startLead: (input, as = caller) => daemon.catalogue.invoke("jobs.startLead", input, as) as never,
        async folder(name) {
            const path = join(env.root, name);
            await mkdir(path);
            await chmod(path, 0o700);
            await agents.runtime().workspaces.register(path);
            return path;
        },
        async seatConversation(slot = { scope: "test", key: "existing" }) {
            const { conversationId } = await createSeatedConversation(ctx.host, {
                ...slot,
                job: { jobId: "other-job", isLead: true, origin: requestOrigin, depth: 0 },
                seat: agents.runtime().catalog.seatFor("gp"),
                actor: caller.actor as never,
            });
            return conversationId;
        },
        async userInputs(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === "pi.user").map((entry) => JSON.stringify(entry.data));
        },
        async answerCount(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === "pi.assistant").length;
        },
        async seatRecords(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === SEAT_RECORD_KIND).map((entry) => entry.data);
        },
        async conversationCount() {
            return (await ctx.host.listConversations()).length;
        },
    };
    return started;
}

async function refusalCode(action: Promise<unknown>): Promise<string> {
    try {
        await action;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
        return error.code;
    }
    throw new Error("expected the operation to be refused");
}

async function waitForInputs(started: Started, conversationId: string, count: number): Promise<string[]> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const inputs = await started.userInputs(conversationId);
        if (inputs.length >= count || Date.now() > deadline) return inputs;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

// Returns the answer count once it reaches `count` or the wait ends.
async function waitForAnswers(started: Started, conversationId: string, count: number, waitMs = WAIT_MS) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const answers = await started.answerCount(conversationId);
        if (answers >= count || Date.now() > deadline) return answers;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

describe("jobs.startLead", () => {
    it("seats the lead conversation as bob with its defaults, its job links and the first input", async () => {
        const started = await start();

        const result = await started.startLead({
            jobId: "job-1",
            firstInput: "plan the release",
            origin: requestOrigin,
        });

        assert.equal(result.created, true);
        const meta = await readConversationMeta(started.ctx.host, result.conversationId);
        assert.equal(meta?.seat.role, "bob");
        assert.equal(meta?.jobId, "job-1");
        assert.equal(meta?.isLead, true);
        assert.equal(meta?.depth, 0);
        assert.deepEqual(meta?.origin, requestOrigin);
        const inputs = await waitForInputs(started, result.conversationId, 1);
        assert.equal(inputs.length, 1);
        assert.match(inputs[0] ?? "", /plan the release/);
    });

    it("seats the named role with the model, thinking level and workspace a request names", async () => {
        const started = await start();
        const workspace = await started.folder("elsewhere");

        const { conversationId } = await started.startLead({
            jobId: "job-2",
            firstInput: "go",
            origin: requestOrigin,
            role: "gp",
            model: `${started.provider}/model-two`,
            thinkingLevel: "low",
            workspace,
        });

        const meta = await readConversationMeta(started.ctx.host, conversationId);
        assert.equal(meta?.seat.role, "gp");
        assert.equal(meta?.seat.model, `${started.provider}/model-two`);
        assert.equal(meta?.seat.thinkingLevel, "low");
        assert.equal(meta?.seat.workspace, workspace);
    });

    it("records a team member's request with the caller's way in, also when the input names another", async () => {
        const started = await start();

        const named = await started.startLead({
            jobId: "way-in",
            firstInput: "go",
            origin: { kind: "request", wayIn: "telegram" },
        });
        const omitted = await started.startLead({ jobId: "no-origin", firstInput: "go" });

        const namedMeta = await readConversationMeta(started.ctx.host, named.conversationId);
        const omittedMeta = await readConversationMeta(started.ctx.host, omitted.conversationId);
        assert.deepEqual(namedMeta?.origin, { kind: "request", wayIn: "cli" });
        assert.deepEqual(omittedMeta?.origin, { kind: "request", wayIn: "cli" });
    });

    it("records the in-process way in for a team member who names none", async () => {
        const started = await start();
        const inProcess: Caller = { actor: { kind: "team_member" } };

        const { conversationId } = await started.startLead(
            { jobId: "in-process", firstInput: "go", origin: { kind: "request", wayIn: "web" } },
            inProcess,
        );

        const meta = await readConversationMeta(started.ctx.host, conversationId);
        assert.deepEqual(meta?.origin, { kind: "request", wayIn: "in-process" });
    });

    it("records an agent's job as a follow-up of the agent's own conversation, with the agent as seat actor", async () => {
        const started = await start();
        const own = await started.seatConversation();
        const agent: Caller = { actor: { kind: "agent", conversationId: own } };

        const { conversationId } = await started.startLead(
            { jobId: "follow-up", firstInput: "go", origin: { kind: "follow_up", conversationId: "999999" } },
            agent,
        );
        const omitted = await started.startLead({ jobId: "follow-up-2", firstInput: "go" }, agent);

        const meta = await readConversationMeta(started.ctx.host, conversationId);
        const omittedMeta = await readConversationMeta(started.ctx.host, omitted.conversationId);
        assert.deepEqual(meta?.origin, { kind: "follow_up", conversationId: own });
        assert.deepEqual(omittedMeta?.origin, { kind: "follow_up", conversationId: own });
        const [record] = (await started.seatRecords(conversationId)) as { actor: unknown }[];
        assert.deepEqual(record?.actor, { kind: "agent", conversationId: own, role: "gp" });
    });

    it("records the origin of each job source kind, seats the role it names with its defaults, and the job source as the seat actor", async () => {
        const started = await start();
        const gpDefaults = await readConversationMeta(started.ctx.host, await started.seatConversation());
        const origins = [
            { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" },
            { kind: "trigger", trigger: "ci", event: "build-failed" },
        ];
        const source: Caller = { actor: { kind: "job_source", source: "schedule" } };

        for (const [index, origin] of origins.entries()) {
            const { conversationId } = await started.startLead(
                { jobId: `source-${index}`, firstInput: "go", origin, role: "gp" },
                source,
            );
            const meta = await readConversationMeta(started.ctx.host, conversationId);
            assert.deepEqual(meta?.origin, origin);
            assert.deepEqual(meta?.seat, gpDefaults?.seat);
            const [record] = (await started.seatRecords(conversationId)) as { actor: unknown }[];
            assert.deepEqual(record?.actor, { kind: "job_source", source: "schedule" });
        }
    });

    it("returns the original conversation on a repeat and submits the first input once", async () => {
        const started = await start();
        const first = await started.startLead({ jobId: "job-3", firstInput: "only once", origin: requestOrigin });
        await waitForInputs(started, first.conversationId, 1);
        const before = await started.conversationCount();

        await waitForAnswers(started, first.conversationId, 1);

        const repeat = await started.startLead({ jobId: "job-3", firstInput: "only once", origin: requestOrigin });
        // A second submission would start another turn; give it time to show before counting.
        const duplicateAnswers = await waitForAnswers(started, first.conversationId, 2, SETTLE_MS);

        assert.deepEqual(repeat, { conversationId: first.conversationId, created: false });
        assert.equal(await started.conversationCount(), before);
        assert.equal(duplicateAnswers, 1);
        assert.equal((await started.userInputs(first.conversationId)).length, 1);
    });

    it("submits the first input to a conversation created before a crash, once", async () => {
        const started = await start();
        const existing = await started.seatConversation({ scope: "jobs.startLead", key: "job-9" });

        await started.startLead({ jobId: "job-9", firstInput: "repair me", origin: requestOrigin });
        await started.startLead({ jobId: "job-9", firstInput: "repair me", origin: requestOrigin });

        const inputs = await waitForInputs(started, existing, 1);
        assert.equal(inputs.length, 1);
        assert.match(inputs[0] ?? "", /repair me/);
    });

    it("returns the conversation that holds the job's key in the jobs.startLead scope", async () => {
        const started = await start();
        const existing = await started.seatConversation({ scope: "jobs.startLead", key: "job-8" });

        const result = await started.startLead({ jobId: "job-8", firstInput: "go", origin: requestOrigin });

        assert.deepEqual(result, { conversationId: existing, created: false });
    });

    it("refuses an unknown role and creates nothing", async () => {
        const started = await start();
        const before = await started.conversationCount();

        const code = await refusalCode(
            started.startLead({ jobId: "job-4", firstInput: "go", origin: requestOrigin, role: "nobody" }),
        );

        assert.equal(code, "not_found");
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses an override that cannot be resolved and creates nothing", async () => {
        const started = await start();
        const before = await started.conversationCount();

        const code = await refusalCode(
            started.startLead({ jobId: "job-5", firstInput: "go", origin: requestOrigin, model: "nope/none" }),
        );

        assert.ok(code === "not_found" || code === "invalid_input");
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses an override named by a source other than a request and creates nothing", async () => {
        const started = await start();
        const own = await started.seatConversation();
        const before = await started.conversationCount();
        const source: Caller = { actor: { kind: "job_source", source: "schedule" } };
        const agent: Caller = { actor: { kind: "agent", conversationId: own } };
        const schedule = { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" };

        const sourceCode = await refusalCode(
            started.startLead({ jobId: "job-6", firstInput: "go", origin: schedule, thinkingLevel: "low" }, source),
        );
        const agentCode = await refusalCode(
            started.startLead({ jobId: "job-6b", firstInput: "go", model: "x" }, agent),
        );

        assert.equal(sourceCode, "invalid_input");
        assert.equal(agentCode, "invalid_input");
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses a team member's input naming another origin kind than a request and creates nothing", async () => {
        const started = await start();
        const existing = await started.seatConversation();
        const before = await started.conversationCount();
        const origins = [
            { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" },
            { kind: "trigger", trigger: "ci", event: "build-failed" },
            { kind: "follow_up", conversationId: existing },
        ];

        for (const [index, origin] of origins.entries()) {
            const code = await refusalCode(started.startLead({ jobId: `wrong-${index}`, firstInput: "go", origin }));
            assert.equal(code, "invalid_input", `origin ${origin.kind}`);
        }
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses an agent's input naming another origin kind than a follow-up and creates nothing", async () => {
        const started = await start();
        const own = await started.seatConversation();
        const before = await started.conversationCount();
        const agent: Caller = { actor: { kind: "agent", conversationId: own } };
        const origins = [
            { kind: "request", wayIn: "cli" },
            { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" },
        ];

        for (const [index, origin] of origins.entries()) {
            const code = await refusalCode(
                started.startLead({ jobId: `agent-wrong-${index}`, firstInput: "go", origin }, agent),
            );
            assert.equal(code, "invalid_input", `origin ${origin.kind}`);
        }
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses a job source's input naming no origin, a request or a follow-up and creates nothing", async () => {
        const started = await start();
        const existing = await started.seatConversation();
        const before = await started.conversationCount();
        const source: Caller = { actor: { kind: "job_source", source: "trigger" } };
        const origins = [undefined, { kind: "request", wayIn: "cli" }, { kind: "follow_up", conversationId: existing }];

        for (const [index, origin] of origins.entries()) {
            const input = { jobId: `source-wrong-${index}`, firstInput: "go", ...(origin && { origin }) };
            const code = await refusalCode(started.startLead(input, source));
            assert.equal(code, "invalid_input", `origin ${origin?.kind ?? "none"}`);
        }
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses an agent caller whose conversation doesn't exist and creates nothing", async () => {
        const started = await start();
        const before = await started.conversationCount();
        const agent: Caller = { actor: { kind: "agent", conversationId: "999999" } };

        const code = await refusalCode(started.startLead({ jobId: "job-7", firstInput: "go" }, agent));

        assert.equal(code, "not_found");
        assert.equal(await started.conversationCount(), before);
    });
});

describe("jobs.create", () => {
    const text = "rotate the staging TLS certificate";

    it("seats the lead as bob with a first input carrying the number and the text", async () => {
        const started = await start();

        const job = await started.create({ text }, cliCaller);

        assert.equal(job.number, "C-1");
        assert.ok(job.status === "to_do" || job.status === "in_progress");
        assert.ok(job.leadConversation);
        const meta = await readConversationMeta(started.ctx.host, job.leadConversation);
        assert.equal(meta?.seat.role, "bob");
        assert.equal(meta?.jobId, job.id);
        const inputs = await waitForInputs(started, job.leadConversation, 1);
        assert.match(inputs[0] ?? "", /C-1/);
        assert.match(inputs[0] ?? "", /rotate the staging TLS certificate/);
        assert.ok((inputs[0] ?? "").includes(LEAD_DUTY));
    });

    it("numbers jobs per letter of their way in", async () => {
        const started = await start();
        const email: Caller = { actor: { kind: "team_member", wayIn: "email" } };

        const numbers = [
            (await started.create({ text }, cliCaller)).number,
            (await started.create({ text }, cliCaller)).number,
            (await started.create({ text }, email)).number,
            (await started.create({ text }, cliCaller)).number,
        ];

        assert.deepEqual(numbers, ["C-1", "C-2", "E-1", "C-3"]);
    });

    it("refuses an unknown role, a way in without a letter and a caller-named origin, using no number", async () => {
        const started = await start();
        const parent = await started.create({ text }, cliCaller);
        const agent: Caller = { actor: { kind: "agent", conversationId: parent.leadConversation as string } };
        const before = await started.conversationCount();
        const origin = { kind: "request", wayIn: "email" };

        const refused = [
            started.create({ text, role: "nobody" }, cliCaller),
            started.create({ text }, caller),
            started.create({ text }, { actor: { kind: "team_member" } }),
            started.create({ text, origin }, cliCaller),
            started.create({ text, origin }, agent),
        ];

        for (const call of refused) assert.equal(await refusalCode(call), "invalid_input");
        assert.equal(await started.conversationCount(), before);
        assert.equal((await started.create({ text }, cliCaller)).number, "C-2");
    });

    it("records an agent's job as a follow-up of its own conversation and a job source's stated origin", async () => {
        const started = await start();
        const parent = await started.create({ text }, cliCaller);
        const agent: Caller = { actor: { kind: "agent", conversationId: parent.leadConversation as string } };
        const schedule = { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" };
        const trigger = { kind: "trigger", trigger: "ci", event: "build-failed" };

        const followUp = await started.create({ text }, agent);
        const scheduled = await started.create(
            { text, origin: schedule },
            { actor: { kind: "job_source", source: "s" } },
        );
        const triggered = await started.create(
            { text, origin: trigger },
            { actor: { kind: "job_source", source: "t" } },
        );

        assert.equal(followUp.number, "A-1");
        assert.deepEqual(followUp.request.origin, {
            kind: "follow_up",
            jobId: parent.id,
            conversationId: parent.leadConversation,
        });
        assert.equal(scheduled.number, "S-1");
        assert.deepEqual(scheduled.request.origin, schedule);
        assert.equal(triggered.number, "T-1");
        assert.deepEqual(triggered.request.origin, trigger);
    });

    it("records statedBy apart from the origin", async () => {
        const started = await start();

        const job = await started.create({ text, statedBy: "Ana" }, cliCaller);

        assert.equal(job.statedBy, "Ana");
        assert.deepEqual(job.request.origin, { kind: "request", wayIn: "command line" });
    });

    it("returns the original job when an idempotency key repeats", async () => {
        const started = await start();

        const first = await started.create({ text, idempotencyKey: "k-1" }, cliCaller);
        const repeat = await started.create({ text, idempotencyKey: "k-1" }, cliCaller);

        assert.equal(repeat.id, first.id);
        assert.equal(repeat.number, "C-1");
        assert.equal(repeat.leadConversation, first.leadConversation);
        assert.equal(await started.conversationCount(), 1);
        assert.equal((await started.create({ text }, cliCaller)).number, "C-2");
    });

    it("sets the job Done as cancelled, by the daemon, when the lead's start is refused after the write", async () => {
        const started = await start((self) => async (point) => {
            if (point === "job-created") await self.invoke("roles.remove", { name: "reviewer" });
        });
        await started.invoke("roles.create", {
            name: "reviewer",
            instructions: "Review the work.",
            tools: ["read"],
            skills: [],
        });

        const job = await started.create({ text, role: "reviewer" }, cliCaller);

        assert.equal(job.status, "done");
        assert.equal(job.resolution?.kind, "cancelled");
        assert.match(job.resolution?.justification ?? "", /reviewer/);
        assert.equal(job.leadConversation, undefined);
        const history = await started.ctx.jobStore.listHistory(job.id, {});
        assert.ok(history.entries.some((entry) => entry.field === "status" && entry.author.kind === "daemon"));
        assert.equal(await started.conversationCount(), 0);
    });
});
