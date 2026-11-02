import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { parkConversation } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { steerConversation } from "../../src/host/steering.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const HELD_TEXT = "the answer that reached the parked lead";
const REASON = "which build is failing?";
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const daemonAuthor = { kind: "daemon" } as const;

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const gates: (() => void)[] = [];

afterEach(async () => {
    for (const release of gates.splice(0)) release();
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Booted = {
    daemon: RunningDaemon;
    ctx: ServiceContext;
    createJob(): Promise<{ id: string; leadConversation: string }>;
    stop(): Promise<void>;
};
type BootOptions = {
    afterWrite?: (point: WritePoint, jobId: string) => void | Promise<void>;
    turnEndRule?: boolean;
    workerThreadCount?: number;
};
type Rig = {
    /** The user messages of every model call so far, in order. */
    modelInputs: string[][];
    /** Holds the model calls that start from now on until `release()`. */
    hold(): { release(): void };
    boot(options?: BootOptions): Promise<Booted>;
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const textOf = (message: Message): string => {
    const { content } = message;
    if (typeof content === "string") return content;
    return content.map((block) => ("text" in block ? block.text : "")).join("");
};

async function createRig(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const modelInputs: string[][] = [];
    let gate: Promise<void> | undefined;
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        modelInputs.push(context.messages.filter((m) => m.role === "user").map(textOf));
        await gate;
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    return {
        modelInputs,
        hold() {
            let release: () => void = () => undefined;
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            gates.push(release);
            return {
                release: () => {
                    gate = undefined;
                    release();
                },
            };
        },
        async boot(options = {}) {
            const agents = await createAgentsComponent({ logger: quietLogger });
            const jobs = await createJobsComponent({
                agents,
                logger: quietLogger,
                turnEndRule: options.turnEndRule ?? false,
                ...(options.afterWrite && { afterWrite: options.afterWrite }),
            });
            let captured: ServiceContext | undefined;
            const probe: DaemonComponent = {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            };
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: env.env,
                homeDir: env.root,
                logger: quietLogger,
                sections: agents.sections,
                components: [agents.component, jobs.component, probe],
                operations: [...agents.operations, ...jobs.operations],
                ...(options.workerThreadCount !== undefined && { workerThreadCount: options.workerThreadCount }),
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
            return {
                daemon,
                ctx: captured as ServiceContext,
                async createJob() {
                    return (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as {
                        id: string;
                        leadConversation: string;
                    };
                },
                async stop() {
                    await daemon.stop();
                },
            };
        },
    };
}

async function historyOf(ctx: ServiceContext, jobId: string) {
    return (await ctx.jobStore.listHistory(jobId, { limit: 100 })).entries;
}

async function repairsOf(ctx: ServiceContext, jobId: string) {
    return (await historyOf(ctx, jobId)).filter((entry) => entry.field === "repair");
}

const rulesOf = (repairs: { new: unknown }[]) => repairs.map((entry) => (entry.new as { rule: number }).rule);

async function leadsOf(ctx: ServiceContext, jobId: string): Promise<string[]> {
    const leads: string[] = [];
    for (const { id } of await ctx.host.listConversations()) {
        const meta = await readConversationMeta(ctx.host, id);
        if (meta?.jobId === jobId && meta.isLead) leads.push(id);
    }
    return leads;
}

const isIdle = async (ctx: ServiceContext, id: string) => (await ctx.host.conversationInfo(id))?.busy === false;

const crashAt =
    (target: WritePoint) =>
    (point: WritePoint): void => {
        if (point === target) throw new Error(`crash at ${point}`);
    };

describe("rule 1: a job with no lead conversation", () => {
    it("starts the lead once, writes one repair entry and changes nothing at a second start", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("job-created") });
        await assert.rejects(first.createJob(), /failed unexpectedly/);
        const [job] = (await first.ctx.jobStore.listJobs({})).jobs;
        assert.ok(job);
        assert.deepEqual(await leadsOf(first.ctx, job.id), []);
        await first.stop();

        const second = await rig.boot();

        const leads = await leadsOf(second.ctx, job.id);
        assert.equal(leads.length, 1);
        await waitFor(() => rig.modelInputs.length === 1, "the lead's first run");
        assert.equal((await second.ctx.jobStore.getJob(job.id)).status, "in_progress");
        const repairs = await repairsOf(second.ctx, job.id);
        assert.deepEqual(rulesOf(repairs), [1]);
        assert.deepEqual(repairs[0]?.author, daemonAuthor);
        assert.equal(repairs[0]?.old, null);
        await waitFor(() => isIdle(second.ctx, leads[0] as string), "the lead to be idle");
        const historyLength = (await historyOf(second.ctx, job.id)).length;
        await second.stop();

        const third = await rig.boot();

        assert.deepEqual(await leadsOf(third.ctx, job.id), leads);
        assert.equal((await historyOf(third.ctx, job.id)).length, historyLength);
        assert.equal(rig.modelInputs.length, 1);
    });

    it("cancels the job with the refusal as justification when the start is refused", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        const { job } = await first.ctx.jobStore.insertJob({
            letter: "W",
            requestText: "do it",
            origin: { kind: "request", wayIn: "web interface" },
            leadStart: { role: "no-such-role", overrides: {}, actor: { kind: "team_member", wayIn: "web interface" } },
        });
        await first.stop();

        const second = await rig.boot();

        const stored = await second.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "done");
        assert.equal(stored.resolution?.kind, "cancelled");
        assert.match(stored.resolution?.justification ?? "", /^The lead could not be started: .*no-such-role/);
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [1]);
        assert.deepEqual(await leadsOf(second.ctx, job.id), []);
    });
});

describe("rules 3 and 2: a Blocked job", () => {
    it("sets the job In progress and delivers a held message before the lead would be parked", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        // The crash between the block and the park: the lead is parked for reports, and an answer is held.
        await parkConversation(first.ctx.host, job.leadConversation, { waitingFor: "reports", continueOn: "all" });
        await first.ctx.jobStore.applyAction(job.id, "block", { blockedReason: REASON }, daemonAuthor);
        await steerConversation(first.ctx.host, job.leadConversation, {
            content: HELD_TEXT,
            mode: "followUp",
            actor: { kind: "team_member", wayIn: "web interface" },
            requestId: "held-1",
        });
        assert.equal((await readConversationMeta(first.ctx.host, job.leadConversation))?.held.length, 1);
        await first.stop();

        const second = await rig.boot();

        const stored = await second.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        const meta = await readConversationMeta(second.ctx.host, job.leadConversation);
        assert.equal(meta?.parked, null);
        assert.deepEqual(meta?.held, []);
        await waitFor(() => rig.modelInputs.some((users) => users.includes(HELD_TEXT)), "the lead to take the message");
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [3]);
    });
});
