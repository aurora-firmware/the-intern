import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { hasQueuedInput, hasSubmissionWithRequestId } from "../../src/host/conversation_control.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { parkConversation } from "../../src/host/invocation.ts";
import { conversationMetaDoc, readConversationMeta } from "../../src/host/seating.ts";
import { steerConversation } from "../../src/host/steering.ts";
import { blockJob, cancelJob, type JobActionDeps } from "../../src/jobs/job_actions.ts";
import { type JobAuthor, reminderRequestId } from "../../src/jobs/job_model.ts";
import { repairJobs } from "../../src/jobs/job_repair.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const HELD_TEXT = "the answer that reached the parked lead";
const REASON = "which build is failing?";
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const daemonAuthor = { kind: "daemon" } as const;
const teamMember: JobAuthor = { kind: "team_member", wayIn: "web interface" };

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
    deps: JobActionDeps;
    createJob(): Promise<{ id: string; leadConversation: string }>;
    stop(): Promise<void>;
};
type BootOptions = {
    afterWrite?: (point: WritePoint, jobId: string) => void | Promise<void>;
    turnEndRule?: boolean;
    /** Waits for the daemon to leave the starting phase, ready or not. */
    isStartupExpectedToFail?: boolean;
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

const abortion = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));

async function createRig(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const modelInputs: string[][] = [];
    let gate: Promise<void> | undefined;
    const answer = async (context: { messages: Message[] }, options?: { signal?: AbortSignal }) => {
        fake.appendResponses([answer]);
        modelInputs.push(context.messages.filter((m) => m.role === "user").map(textOf));
        // A held call ends when it is released or aborted, so stopping the daemon does not wait for it.
        await Promise.race([gate, abortion(options?.signal)]);
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
            if (options.isStartupExpectedToFail) {
                await waitFor(() => daemon.phase() !== "starting", "the daemon to finish starting");
            } else {
                await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
            }
            return {
                daemon,
                ctx: captured as ServiceContext,
                deps: { ctx: captured as ServiceContext, options: jobs.options },
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
        const length = (await historyOf(second.ctx, job.id)).length;
        await second.stop();

        const third = await rig.boot();

        assert.equal((await historyOf(third.ctx, job.id)).length, length);
    });
});

describe("rule 1: a start that fails for another reason than a refusal", () => {
    it("fails the startup instead of cancelling the job", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        await first.ctx.jobStore.insertJob({
            letter: "W",
            requestText: "do it",
            origin: { kind: "request", wayIn: "web interface" },
            leadStart: null,
        });
        await first.stop();

        const second = await rig.boot({ isStartupExpectedToFail: true });

        assert.equal(second.daemon.phase(), "stopping");
        assert.equal(await second.daemon.exited, 1);
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

describe("rule 2: a Blocked job whose lead is not parked", () => {
    it("parks the lead for an answer and writes one repair entry", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("job-blocked") });
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await assert.rejects(blockJob(first.deps, job.id, REASON, teamMember), /crash at job-blocked/);
        assert.equal((await readConversationMeta(first.ctx.host, job.leadConversation))?.parked, null);
        await first.stop();

        const second = await rig.boot();

        const meta = await readConversationMeta(second.ctx.host, job.leadConversation);
        assert.deepEqual(meta?.parked, { waitingFor: "answer", continueOn: "each" });
        assert.equal((await second.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [2]);
    });

    it("writes nothing for a parked lead, and an older held message stays held", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await parkConversation(first.ctx.host, job.leadConversation, { waitingFor: "reports", continueOn: "all" });
        await steerConversation(first.ctx.host, job.leadConversation, {
            content: HELD_TEXT,
            mode: "followUp",
            actor: teamMember,
            requestId: "held-1",
        });
        await blockJob(first.deps, job.id, REASON, teamMember);
        await first.stop();

        const second = await rig.boot();

        assert.deepEqual(await repairsOf(second.ctx, job.id), []);
        assert.equal((await second.ctx.jobStore.getJob(job.id)).status, "blocked");
        const meta = await readConversationMeta(second.ctx.host, job.leadConversation);
        assert.equal(meta?.parked?.waitingFor, "answer");
        assert.equal(meta?.held.length, 1);
    });
});

describe("rule 3: input the lead has not taken", () => {
    it("resumes the job and unparks the lead when input is queued for the run the lead is in", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("lead-input") });
        const heldCall = rig.hold();
        const job = await first.createJob();
        await waitFor(() => rig.modelInputs.length === 1, "the lead's run to be in its model call");
        // The lead blocks the job from inside its run, and an answer queues for that run.
        await blockJob(first.deps, job.id, REASON, teamMember);
        await assert.rejects(
            steerConversation(first.ctx.host, job.leadConversation, {
                content: HELD_TEXT,
                mode: "followUp",
                actor: teamMember,
                requestId: "answer-1",
            }),
        );
        assert.equal((await first.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.equal(await hasQueuedInput(first.ctx.host, job.leadConversation), true);
        await first.stop();

        const second = await rig.boot();

        const stored = await second.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        assert.equal((await readConversationMeta(second.ctx.host, job.leadConversation))?.parked, null);
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [3]);
        heldCall.release();
        await waitFor(() => rig.modelInputs.some((users) => users.includes(HELD_TEXT)), "the lead to take the answer");
    });

    it("unparks the lead when the input queued before the park and the crash came before the resume", async () => {
        const rig = await createRig();
        const steerAnswer = (ctx: ServiceContext, leadId: string) =>
            steerConversation(ctx.host, leadId, {
                content: HELD_TEXT,
                mode: "followUp",
                actor: teamMember,
                requestId: "answer-1",
            });
        let leadId = "";
        let ctxOfFirst: ServiceContext | undefined;
        const first = await rig.boot({
            afterWrite: async (point) => {
                // The answer queues for the running lead after the block is written and before the lead parks.
                if (point === "job-blocked") await assert.rejects(steerAnswer(ctxOfFirst as ServiceContext, leadId));
                if (point === "lead-input") throw new Error("crash at lead-input");
            },
        });
        ctxOfFirst = first.ctx;
        const heldCall = rig.hold();
        const job = await first.createJob();
        leadId = job.leadConversation;
        await waitFor(() => rig.modelInputs.length === 1, "the lead's run to be in its model call");
        await blockJob(first.deps, job.id, REASON, teamMember);
        assert.equal((await first.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.equal(await hasQueuedInput(first.ctx.host, job.leadConversation), true);
        assert.notEqual((await readConversationMeta(first.ctx.host, job.leadConversation))?.parked, null);
        await first.stop();

        const second = await rig.boot();

        assert.equal((await second.ctx.jobStore.getJob(job.id)).status, "in_progress");
        assert.equal((await readConversationMeta(second.ctx.host, job.leadConversation))?.parked, null);
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [3]);
        heldCall.release();
        await waitFor(() => rig.modelInputs.some((users) => users.includes(HELD_TEXT)), "the lead to take the answer");
    });
});

describe("rule 3: input the lead took since the job blocked", () => {
    it("resumes the job when an idle parked lead took the answer before the crash", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("lead-input") });
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await blockJob(first.deps, job.id, REASON, teamMember);
        // The answer reaches the idle lead and is taken; the crash comes before the job's resume is written.
        await assert.rejects(
            steerConversation(first.ctx.host, job.leadConversation, {
                content: HELD_TEXT,
                mode: "followUp",
                actor: teamMember,
                requestId: "answer-1",
            }),
            /crash at lead-input/,
        );
        assert.equal((await first.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.equal(await hasQueuedInput(first.ctx.host, job.leadConversation), false);
        assert.equal((await readConversationMeta(first.ctx.host, job.leadConversation))?.held.length, 0);
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle again");
        await first.stop();

        const second = await rig.boot();

        const stored = await second.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "in_progress");
        assert.equal(stored.blockedReason, undefined);
        assert.equal((await readConversationMeta(second.ctx.host, job.leadConversation))?.parked, null);
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [3]);
    });
});

describe("rule 4: a Done job with active conversations", () => {
    it("aborts a parked lead and writes one repair entry", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("job-cancelled") });
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await blockJob(first.deps, job.id, REASON, teamMember);
        await assert.rejects(cancelJob(first.deps, job.id, "no longer needed", teamMember), /crash at job-cancelled/);
        assert.notEqual((await readConversationMeta(first.ctx.host, job.leadConversation))?.parked, null);
        await first.stop();

        const second = await rig.boot();

        assert.equal((await readConversationMeta(second.ctx.host, job.leadConversation))?.parked, null);
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [4]);
        const length = (await historyOf(second.ctx, job.id)).length;
        await second.stop();

        const third = await rig.boot();

        assert.equal((await historyOf(third.ctx, job.id)).length, length);
    });
});

describe("rules 3 and 4: jobs with nothing to repair", () => {
    it("writes nothing for an In progress job whose parked lead holds a message for its reports", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await parkConversation(first.ctx.host, job.leadConversation, { waitingFor: "reports", continueOn: "all" });
        await steerConversation(first.ctx.host, job.leadConversation, {
            content: HELD_TEXT,
            mode: "followUp",
            actor: teamMember,
            requestId: "held-1",
        });
        await first.stop();

        const second = await rig.boot();

        assert.deepEqual(await repairsOf(second.ctx, job.id), []);
        assert.equal((await readConversationMeta(second.ctx.host, job.leadConversation))?.held.length, 1);
    });

    it("writes nothing for a Done job whose conversations are idle", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await cancelJob(first.deps, job.id, "no longer needed", teamMember);
        await first.stop();

        const second = await rig.boot();

        assert.deepEqual(await repairsOf(second.ctx, job.id), []);
    });
});

describe("the cost of the repair", () => {
    it("lists the conversations once, however many Done jobs the instance holds", async () => {
        const rig = await createRig();
        const booted = await rig.boot({ turnEndRule: true });
        for (let count = 0; count < 5; count += 1) {
            const job = await booted.createJob();
            await waitFor(() => isIdle(booted.ctx, job.leadConversation), "the lead to be idle");
            await cancelJob(booted.deps, job.id, "no longer needed", teamMember);
        }
        const { host } = booted.ctx;
        const listConversations = host.listConversations;
        let listings = 0;
        host.listConversations = () => {
            listings += 1;
            return listConversations();
        };

        try {
            await repairJobs(booted.deps);
        } finally {
            host.listConversations = listConversations;
        }

        assert.equal(listings, 1);
    });
});

describe("rule 4: conversations that run or await a report", () => {
    it("aborts a lead whose run was in flight", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("job-cancelled") });
        const heldCall = rig.hold();
        const job = await first.createJob();
        await waitFor(() => rig.modelInputs.length === 1, "the lead's run to be in its model call");
        await assert.rejects(cancelJob(first.deps, job.id, "no longer needed", teamMember), /crash at job-cancelled/);
        await first.stop();

        const second = await rig.boot();

        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [4]);
        assert.equal(await isIdle(second.ctx, job.leadConversation), true);
        heldCall.release();
        assert.equal(rig.modelInputs.length, 1);
    });

    it("clears a lead that awaits a report", async () => {
        const rig = await createRig();
        const first = await rig.boot({ afterWrite: crashAt("job-cancelled") });
        const job = await first.createJob();
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await assert.rejects(cancelJob(first.deps, job.id, "no longer needed", teamMember), /crash at job-cancelled/);
        await internalHarness(first.ctx.host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, Number(job.leadConversation) as never);
            meta.awaiting.push("99");
        }, BACKGROUND_CONTEXT);
        await first.stop();

        const second = await rig.boot();

        assert.deepEqual((await readConversationMeta(second.ctx.host, job.leadConversation))?.awaiting, []);
        assert.deepEqual(rulesOf(await repairsOf(second.ctx, job.id)), [4]);
    });
});

describe("the turn-end check at startup", () => {
    /** Boots a daemon whose turn-end hook throws from its `crashOn`th call on, and counts the calls. */
    async function bootCrashingAtTurnEnd(rig: Rig, crashOn: number) {
        const calls = { count: 0 };
        const booted = await rig.boot({
            turnEndRule: true,
            afterWrite: (point) => {
                if (point !== "turn-ended") return;
                calls.count += 1;
                if (calls.count >= crashOn) throw new Error("crash at turn-ended");
            },
        });
        return { booted, calls };
    }

    async function createJobWithDefinitionOfDone(rig: Rig, booted: Booted) {
        const heldCall = rig.hold();
        const job = await booted.createJob();
        await waitFor(() => rig.modelInputs.length === 1, "the lead's run to be in its model call");
        await booted.ctx.jobStore.updateFields(job.id, { definitionOfDone: "the report is filed" }, teamMember);
        heldCall.release();
        return job;
    }

    const isReminderSubmitted = (booted: Booted, job: { id: string; leadConversation: string }) =>
        hasSubmissionWithRequestId(booted.ctx.host, job.leadConversation, reminderRequestId(job.id, 0));

    it("reminds the lead of an In progress job whose turn ended before the daemon handled it", async () => {
        const rig = await createRig();
        const { booted: first, calls } = await bootCrashingAtTurnEnd(rig, 1);
        const job = await createJobWithDefinitionOfDone(rig, first);
        await waitFor(() => calls.count === 1, "the turn-end hook");
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await first.stop();

        const second = await rig.boot({ turnEndRule: true });

        assert.equal(await isReminderSubmitted(second, job), true);
        await waitFor(() => rig.modelInputs.some((users) => users.includes(REMINDER_TEXT)), "the reminder to arrive");
        assert.deepEqual(await repairsOf(second.ctx, job.id), []);
    });

    it("blocks the job when the reminder was spent before the restart", async () => {
        const rig = await createRig();
        const { booted: first, calls } = await bootCrashingAtTurnEnd(rig, 2);
        const job = await createJobWithDefinitionOfDone(rig, first);
        await waitFor(() => calls.count === 2, "the second turn-end hook");
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await first.stop();

        const second = await rig.boot({ turnEndRule: true });

        const stored = await second.ctx.jobStore.getJob(job.id);
        assert.equal(stored.status, "blocked");
        assert.ok(stored.blockedReason);
        assert.notEqual((await readConversationMeta(second.ctx.host, job.leadConversation))?.parked, null);
        const blocks = (await historyOf(second.ctx, job.id)).filter((entry) => entry.new === "blocked");
        assert.deepEqual(
            blocks.map((entry) => entry.author),
            [daemonAuthor],
        );
    });

    it("blocks the job when its definition of done is empty", async () => {
        const rig = await createRig();
        const { booted: first, calls } = await bootCrashingAtTurnEnd(rig, 1);
        const job = await first.createJob();
        await waitFor(() => calls.count === 1, "the turn-end hook");
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await first.stop();

        const second = await rig.boot({ turnEndRule: true });

        assert.equal((await second.ctx.jobStore.getJob(job.id)).status, "blocked");
        assert.equal(await isReminderSubmitted(second, job), false);
    });

    it("applies nothing when the Jobs component has no turn-end rule", async () => {
        const rig = await createRig();
        const { booted: first, calls } = await bootCrashingAtTurnEnd(rig, 1);
        const job = await createJobWithDefinitionOfDone(rig, first);
        await waitFor(() => calls.count === 1, "the turn-end hook");
        await waitFor(() => isIdle(first.ctx, job.leadConversation), "the lead to be idle");
        await first.stop();

        const second = await rig.boot({ turnEndRule: false });

        assert.equal(await isReminderSubmitted(second, job), false);
    });

    it("leaves a lead whose run resumes alone", async () => {
        const rig = await createRig();
        const { booted: first } = await bootCrashingAtTurnEnd(rig, 1);
        const heldCall = rig.hold();
        const job = await first.createJob();
        await waitFor(() => rig.modelInputs.length === 1, "the lead's run to be in its model call");
        await first.ctx.jobStore.updateFields(job.id, { definitionOfDone: "the report is filed" }, teamMember);
        await first.stop();

        const second = await rig.boot({ turnEndRule: true });

        assert.equal(await isReminderSubmitted(second, job), false);
        assert.equal((await second.ctx.jobStore.getJob(job.id)).status, "in_progress");
        heldCall.release();
    });
});
