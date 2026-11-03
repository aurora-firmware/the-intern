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
import { submitInput } from "../../src/host/conversation_control.ts";
import { abortJobConversations } from "../../src/host/invocation.ts";
import { createSeatedConversation, readConversationMeta } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { createJobToolsExtension } from "../../src/jobs/job_tools_extension.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_MS = 300;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

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

type Booted = { daemon: RunningDaemon; ctx: ServiceContext; seatFor(role: string): Seat; stop(): Promise<void> };
type Rig = {
    /** Holds the model calls that start from now on until `release()`. */
    hold(): { release(): void };
    boot(): Promise<Booted>;
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const abortion = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));

async function createRig(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let gate: Promise<void> | undefined;
    const answer = async (_context: { messages: Message[] }, options?: { signal?: AbortSignal }) => {
        fake.appendResponses([answer]);
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
        async boot() {
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
                seatFor: (role) => jobs.options.agents.runtime().catalog.seatFor(role),
                async stop() {
                    await daemon.stop();
                },
            };
        },
    };
}

// Seats a conversation as the front desk will be: no job, no lead flag, the origin "front desk".
async function seatJobless(booted: Booted, key: string): Promise<string> {
    const { conversationId } = await createSeatedConversation(booted.ctx.host, {
        scope: "jobless-test",
        key,
        job: { jobId: null, isLead: false, origin: { kind: "front_desk" }, depth: 0 },
        seat: booted.seatFor(DEFAULT_LEAD_ROLE),
        actor: { kind: "daemon" },
    });
    return conversationId;
}

const send = (ctx: ServiceContext, conversationId: string, content: string) =>
    submitInput(ctx.host, conversationId, {
        content,
        requestId: `req-${conversationId}-${content}`,
        busyMode: "followUp",
    });

const isIdle = async (ctx: ServiceContext, id: string) => (await ctx.host.conversationInfo(id))?.busy === false;
const isBusy = async (ctx: ServiceContext, id: string) => (await ctx.host.conversationInfo(id))?.busy === true;

describe("a conversation with no job", () => {
    it("stores jobId null, no lead flag and the front desk origin", async () => {
        const booted = await (await createRig()).boot();

        const id = await seatJobless(booted, "front-desk");

        const meta = await readConversationMeta(booted.ctx.host, id);
        assert.equal(meta?.jobId, null);
        assert.equal(meta?.isLead, false);
        assert.deepEqual(meta?.origin, { kind: "front_desk" });
    });

    it("is left untouched when every conversation of a job is aborted", async () => {
        const rig = await createRig();
        const booted = await rig.boot();
        const jobless = await seatJobless(booted, "front-desk");
        const job = (await booted.daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as {
            id: string;
            leadConversation: string;
        };
        const hold = rig.hold();
        await send(booted.ctx, jobless, "hello");
        await send(booted.ctx, job.leadConversation, "more");
        await waitFor(
            async () => (await isBusy(booted.ctx, jobless)) && (await isBusy(booted.ctx, job.leadConversation)),
            "both to be busy",
        );

        const aborted = await abortJobConversations(booted.ctx.host, job.id);

        assert.ok(aborted.includes(job.leadConversation));
        assert.ok(!aborted.includes(jobless));
        await waitFor(() => isIdle(booted.ctx, job.leadConversation), "the job's lead to stop");
        assert.equal(await isBusy(booted.ctx, jobless), true);
        assert.equal((await readConversationMeta(booted.ctx.host, jobless))?.aborted, false);
        hold.release();
    });

    it("gets no reminder and writes no job history when its turn ends", async () => {
        const booted = await (await createRig()).boot();
        const jobless = await seatJobless(booted, "front-desk");

        await send(booted.ctx, jobless, "hello");
        await waitFor(() => isIdle(booted.ctx, jobless), "the turn to end");
        await settle();

        const { entries } = await booted.ctx.host.readEntries(jobless, { limit: 1000 });
        assert.equal(entries.filter((entry) => entry.kind === STEER_RECORD_KIND).length, 0);
        assert.equal(JSON.stringify(entries).includes(REMINDER_TEXT), false);
        const jobs = await booted.ctx.jobStore.listJobs({ limit: 100 });
        for (const { id } of jobs.jobs) {
            const history = await booted.ctx.jobStore.listHistory(id, { limit: 100 });
            assert.equal(history.entries.filter((entry) => entry.field === "reminder").length, 0);
        }
    });

    it("is skipped by repair at restart and listed with jobId null by the instance feed", async () => {
        const rig = await createRig();
        const first = await rig.boot();
        const jobless = await seatJobless(first, "front-desk");
        const before = await readConversationMeta(first.ctx.host, jobless);
        await first.stop();

        const second = await rig.boot();

        const after = await readConversationMeta(second.ctx.host, jobless);
        assert.deepEqual(after, before);
        for (const { id } of (await second.ctx.jobStore.listJobs({ limit: 100 })).jobs) {
            const history = await second.ctx.jobStore.listHistory(id, { limit: 100 });
            assert.equal(history.entries.filter((entry) => entry.field === "repair").length, 0);
        }
        const { snapshot } = second.ctx.instanceFeed.subscribe();
        const listed = snapshot.conversations.find((conversation) => conversation.id === jobless);
        assert.equal(listed?.jobId, null);
        assert.equal(listed?.isLead, false);
    });

    it("returns an error result when a job tool is called in it", async () => {
        const booted = await (await createRig()).boot();
        const jobless = await seatJobless(booted, "front-desk");
        const extension = createJobToolsExtension({
            host: () => booted.ctx.host,
            jobStore: () => booted.ctx.jobStore,
        } as never);
        const readJob = extension.tools?.find((tool) => tool.name === "read_job");

        const result = await (readJob as never as { execute(args: object, api: object): Promise<unknown> }).execute(
            {},
            { conversationId: jobless },
        );

        const { isError, output } = result as { isError?: boolean; output: { text: string }[] };
        assert.equal(isError, true);
        assert.match(output[0]?.text ?? "", new RegExp(`read_job was refused: Conversation ${jobless} has no job`));
    });

    it("refuses a follow-up job created from it as invalid input", async () => {
        const booted = await (await createRig()).boot();
        const jobless = await seatJobless(booted, "front-desk");
        const caller: Caller = { actor: { kind: "agent", conversationId: jobless } };

        const error = await booted.daemon.catalogue.invoke("jobs.create", { text: "follow up" }, caller).then(
            () => undefined,
            (rejection: unknown) => rejection,
        );

        assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
        assert.equal(error.code, "invalid_input");
        assert.equal((await booted.ctx.jobStore.listJobs({ limit: 100 })).jobs.length, 0);
    });
});
