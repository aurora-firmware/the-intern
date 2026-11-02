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
import { hasQueuedInput, hasSubmissionWithRequestId, submitInput } from "../../src/host/conversation_control.ts";
import { parkConversation } from "../../src/host/invocation.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { reminderRequestId } from "../../src/jobs/job_model.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { checkTurnEnd, REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import { leadConversationOf } from "../../src/service/job_operations.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_MS = 250;
const TEAM_TEXT = "please also check the staging copy";
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const DAEMON = { kind: "daemon" };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls: Call[] } | { hold: Promise<unknown>; onEntered?: () => void };
type CreatedJob = { id: string; number: string; leadConversation: string };
type StartOptions = { turnEndRule?: boolean; lines?: string[] };
type Hooks = { onWrite?: (point: WritePoint, jobId: string) => void | Promise<void> };

const call = (name: string, args: Record<string, unknown>): Step => ({ calls: [{ name, arguments: args }] });
const invokeAndWait = (jobPrompt: string, mode: "parked" | "steerable"): Step =>
    call("invoke", {
        agents: [{ role: "gp", contextMode: "clean", jobPrompt }],
        // biome-ignore lint/suspicious/noThenProperty: `then` is the parameter name the specification gives the tool
        then: mode,
    });
const setDefinitionOfDone: Step = call("update_job", { definitionOfDone: "the report is filed" });

function deferred() {
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

/**
 * A daemon whose conversations follow scripts. A conversation follows the script whose key its first user message
 * contains, one step per model reply; any other conversation (and a script that has run out) answers in plain text.
 */
async function start(scripts: Record<string, Step[]>, options: StartOptions = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const userMessages: Record<string, string[]> = {};
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        const users = context.messages.filter((message) => message.role === "user").map((m) => textOf(m.content));
        const key = Object.keys(scripts).find((candidate) => users[0]?.includes(candidate));
        if (key === undefined) return fauxAssistantMessage("done");
        userMessages[key] = users;
        const step = (scripts[key] as Step[])[context.messages.filter((m) => m.role === "assistant").length];
        if (step === undefined) return fauxAssistantMessage("finished");
        if ("hold" in step) {
            step.onEntered?.();
            await step.hold;
            return fauxAssistantMessage("done");
        }
        return fauxAssistantMessage(
            step.calls.map((c) => fauxToolCall(c.name, c.arguments as never)),
            { stopReason: "toolUse" },
        );
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const lines = options.lines ?? [];
    const logger = createLogger({
        stream: {
            write: (chunk) => {
                lines.push(String(chunk));
                return true;
            },
        },
    });
    const hooks: Hooks = {};
    const points: { point: WritePoint; jobId: string }[] = [];
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({
        agents,
        logger,
        ...(options.turnEndRule !== undefined && { turnEndRule: options.turnEndRule }),
        afterWrite: async (point, jobId) => {
            points.push({ point, jobId });
            await hooks.onWrite?.(point, jobId);
        },
    });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        checkModels: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
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
    await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
    const ctx = captured as ServiceContext;
    const createJob = async (text: string): Promise<CreatedJob> =>
        (await daemon.catalogue.invoke("jobs.create", { text }, webCaller)) as CreatedJob;
    const status = async (jobId: string) => (await ctx.jobStore.getJob(jobId)).status;
    const turnEndsOf = (jobId: string) => points.filter((p) => p.point === "turn-ended" && p.jobId === jobId).length;
    return {
        ctx,
        hooks,
        userMessages,
        createJob,
        status,
        turnEndsOf,
        jobDeps: { ctx, options: jobs.options },
        leadSeat: () => agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE),
        invoke: (name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller),
        isIdle: async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false,
        /** Reminders (and other steers) in the lead's transcript. */
        steersOf: async (leadId: string) =>
            (await ctx.host.readEntries(leadId, { limit: 200 })).entries
                .filter((entry) => entry.kind === STEER_RECORD_KIND)
                .map((entry) => entry.data as { actor: unknown; mode: string; content: string }),
        statusChanges: async (jobId: string) =>
            (await ctx.jobStore.listHistory(jobId, { limit: 100 })).entries.filter((e) => e.field === "status"),
        /**
         * Returns once the rule has finished everything it was handed before now: the rule's queue is serial, so a
         * marker job whose lead has stopped and reached "turn-ended" proves the earlier items are done.
         */
        async barrier() {
            const marker = await createJob("marker job");
            await waitFor(() => turnEndsOf(marker.id) === 1, "the marker job's turn to end");
        },
    };
}

describe("the turn-end rule", () => {
    it("blocks a job with no definition of done when its lead stops, with the daemon as author (AC-1)", async () => {
        const started = await start({ "no definition": [] });
        const job = await started.createJob("no definition of done here");

        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.blockedReason, "no definition of done");
        const [, blocked] = await started.statusChanges(job.id);
        assert.deepEqual([blocked?.new, blocked?.author], ["blocked", DAEMON]);
        const reasons = (await started.ctx.jobStore.listHistory(job.id, { limit: 100 })).entries.filter(
            (entry) => entry.field === "blockedReason",
        );
        assert.deepEqual(
            reasons.map((entry) => [entry.new, entry.author]),
            [["no definition of done", DAEMON]],
        );
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
    });

    it("sends one reminder after the first stop and blocks after the second (AC-2)", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        const job = await started.createJob("with definition of done");

        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        const steers = await started.steersOf(job.leadConversation);
        assert.deepEqual(steers, [{ actor: DAEMON, mode: "followUp", content: REMINDER_TEXT }]);
        assert.deepEqual(started.userMessages["with definition"]?.slice(1), [REMINDER_TEXT]);
        const stored = await started.ctx.jobStore.getJob(job.id);
        assert.equal(stored.blockedReason, "the lead stopped without completing or blocking");
        const [, blocked] = await started.statusChanges(job.id);
        assert.deepEqual([blocked?.new, blocked?.author], ["blocked", DAEMON]);
        assert.equal(
            await hasSubmissionWithRequestId(started.ctx.host, job.leadConversation, reminderRequestId(job.id, 0)),
            true,
        );
    });

    it("sends no reminder while the lead is parked for a running invoked agent (AC-3)", async () => {
        const gate = deferred();
        const started = await start({
            "parked lead": [setDefinitionOfDone, invokeAndWait("slow worker", "parked")],
            "slow worker": [{ hold: gate.promise }],
        });
        const job = await started.createJob("parked lead");
        await waitFor(() => started.turnEndsOf(job.id) === 1, "the lead's turn to end");
        await started.barrier();

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        gate.release();
    });

    it("sends no reminder while a steerable invoked agent of the job runs (AC-3)", async () => {
        const gate = deferred();
        const started = await start({
            "steerable lead": [setDefinitionOfDone, invokeAndWait("slow helper", "steerable")],
            "slow helper": [{ hold: gate.promise }],
        });
        const job = await started.createJob("steerable lead");
        await waitFor(() => started.turnEndsOf(job.id) === 1, "the lead's turn to end");
        await started.barrier();

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        gate.release();
    });

    it("gives the next stop a new reminder after the job blocked and resumed (AC-4)", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        const job = await started.createJob("with definition of done");
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        await started.invoke("jobs.resume", { job: job.id });
        await waitFor(async () => (await started.steersOf(job.leadConversation)).length === 3, "a new reminder");

        const contents = (await started.steersOf(job.leadConversation)).map((steer) => steer.content);
        assert.equal(contents.filter((content) => content === REMINDER_TEXT).length, 2);
        const { host } = started.ctx;
        for (const n of [0, 2]) {
            assert.equal(
                await hasSubmissionWithRequestId(host, job.leadConversation, reminderRequestId(job.id, n)),
                true,
            );
        }
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block again");
    });

    it("applies no rule when the Jobs component is created with turnEndRule false (AC-5)", async () => {
        const started = await start({ "no definition": [] }, { turnEndRule: false });
        const job = await started.createJob("no definition of done here");
        await waitFor(async () => started.isIdle(job.leadConversation), "the lead to stop");

        await settle();

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
    });

    it("applies no rule to a lead whose job is not in the job store (AC-5)", async () => {
        const lines: string[] = [];
        const started = await start({}, { lines });
        const { ctx } = started;
        const { conversationId } = await createSeatedConversation(ctx.host, {
            scope: "test",
            key: "orphan",
            job: { jobId: "no-such-job", isLead: true, origin: { kind: "request", wayIn: "test" }, depth: 0 },
            seat: started.leadSeat(),
            actor: { kind: "team_member", wayIn: "test" },
        });
        await submitInput(ctx.host, conversationId, { content: "go", requestId: "r1", busyMode: "followUp" });
        await waitFor(() => started.isIdle(conversationId), "the run to end");

        await started.barrier();

        assert.deepEqual(await started.steersOf(conversationId), []);
        assert.equal(
            lines.some((line) => line.includes(" ERROR ")),
            false,
        );
    });
});

describe("the turn-end rule beside other actors", () => {
    it("does nothing for a stop whose job was completed before the check ran", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        started.hooks.onWrite = async (point, jobId) => {
            if (point === "turn-ended") {
                await started.invoke("jobs.complete", { job: jobId, justification: "done by a team member" });
            }
        };
        const job = await started.createJob("with definition of done");
        await waitFor(async () => (await started.status(job.id)) === "done", "the job to be Done");

        await started.barrier();

        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        assert.deepEqual(
            (await started.statusChanges(job.id)).map((entry) => entry.new),
            ["in_progress", "done"],
        );
    });

    it("sends no reminder when a team member's input starts the lead's next run before the check", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] });
        let isInjected = false;
        started.hooks.onWrite = async (point, jobId) => {
            if (point !== "turn-ended" || isInjected) return;
            isInjected = true;
            await started.invoke("conversations.submit", {
                conversationId: await leadConversationOf(started.ctx.host, jobId),
                content: TEAM_TEXT,
                requestId: "team-1",
                busyMode: "followUp",
            });
        };
        const job = await started.createJob("with definition of done");
        await waitFor(async () => (await started.status(job.id)) === "blocked", "the job to block");

        assert.deepEqual(started.userMessages["with definition"]?.slice(1), [TEAM_TEXT, REMINDER_TEXT]);
    });

    it("does nothing for a lead that still has a run, with or without queued input", async () => {
        const gate = deferred();
        let isHolding = false;
        const started = await start(
            {
                "busy lead": [
                    setDefinitionOfDone,
                    {
                        hold: gate.promise,
                        onEntered: () => {
                            isHolding = true;
                        },
                    },
                ],
            },
            { turnEndRule: false },
        );
        const job = await started.createJob("busy lead");
        await waitFor(() => isHolding, "the lead to hold its run");

        await checkTurnEnd(started.jobDeps, job.id);
        assert.equal(await hasQueuedInput(started.ctx.host, job.leadConversation), false);
        await submitInput(started.ctx.host, job.leadConversation, {
            content: TEAM_TEXT,
            requestId: "team-1",
            busyMode: "followUp",
        });
        assert.equal(await hasQueuedInput(started.ctx.host, job.leadConversation), true);
        await checkTurnEnd(started.jobDeps, job.id);

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
        gate.release();
    });

    it("does nothing for an idle lead that is parked", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] }, { turnEndRule: false });
        const job = await started.createJob("with definition of done");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop");
        await parkConversation(started.ctx.host, job.leadConversation, { waitingFor: "reports", continueOn: "each" });

        await checkTurnEnd(started.jobDeps, job.id);

        assert.equal(await started.status(job.id), "in_progress");
        assert.deepEqual(await started.steersOf(job.leadConversation), []);
    });

    it("sends the reminder and then blocks when the check is called directly for an idle lead", async () => {
        const started = await start({ "with definition": [setDefinitionOfDone] }, { turnEndRule: false });
        const job = await started.createJob("with definition of done");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop");

        await checkTurnEnd(started.jobDeps, job.id);
        await waitFor(async () => (await started.steersOf(job.leadConversation)).length === 1, "the reminder");
        await waitFor(() => started.isIdle(job.leadConversation), "the lead to stop again");
        await checkTurnEnd(started.jobDeps, job.id);

        assert.equal(await started.status(job.id), "blocked");
        assert.equal((await started.steersOf(job.leadConversation)).length, 1);
    });

    it("logs a failed check and still handles the next stop", async () => {
        const lines: string[] = [];
        const started = await start({ "with definition": [setDefinitionOfDone] }, { lines });
        let isFirst = true;
        started.hooks.onWrite = (point) => {
            if (point !== "turn-ended" || !isFirst) return;
            isFirst = false;
            throw new Error("the hook failed");
        };
        await started.createJob("with definition of done");
        await waitFor(() => lines.some((line) => line.includes("the hook failed")), "the failure to be logged");

        const next = await started.createJob("no definition of done here");

        await waitFor(async () => (await started.status(next.id)) === "blocked", "the next job to block");
        assert.ok(lines.some((line) => line.includes(" ERROR ")));
    });
});
