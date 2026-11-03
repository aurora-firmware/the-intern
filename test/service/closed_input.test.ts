/**
 * Input to a closed conversation (S-001 REQ-026, REQ-020; ADR-001 decision 4): `submitInput`, `steerConversation` and
 * `holdForParked` refuse a conversation whose closed mark is set or whose job is Done, and the jobs component
 * registers the Done check that makes the refusal hold before the closed marks commit.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage, type Models } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { type BusyMode, submissionState, submitInput } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { abortJobConversations } from "../../src/host/invocation.ts";
import { ConversationClosedError, setJobDoneCheck, setSectionHook } from "../../src/host/job_section.ts";
import {
    conversationMetaDoc,
    createSeatedConversation,
    readConversationMeta,
    type SeatActor,
} from "../../src/host/seating.ts";
import { holdForParked, STEER_RECORD_KIND, steerConversation } from "../../src/host/steering.ts";
import { cancelJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_PAUSE_MS = 100;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const author: JobAuthor = { kind: "team_member", wayIn: "web interface" };
const steerActor: SeatActor = { kind: "team_member", wayIn: "web interface" };

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: { unregister(): void }[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await pause(POLL_MS);
    }
}

function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

function modelsFor(fake: ReturnType<typeof createFakeModel>): Models {
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation, "the fake model's api is registered");
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return models;
}

async function openHostFixture() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [],
        defaultCwd: process.cwd(),
        logger: quietLogger,
    });
    hosts.push(host);
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace: env.root,
        instructions: "Work.",
        tools: [],
        skills: [],
    };
    const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
    const seat_ = async (key: string, jobId: string | null) =>
        (
            await createSeatedConversation(host, {
                scope: "closed-input",
                key,
                job:
                    jobId === null
                        ? { jobId: null, isLead: false, origin: { kind: "front_desk" }, depth: 0 }
                        : { jobId, isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat,
                actor,
            })
        ).conversationId;
    return { host, lead: (jobId: string) => seat_(`${jobId}-lead`, jobId), frontDesk: () => seat_("desk", null) };
}

const BUSY_MODES: BusyMode[] = ["followUp", "steer", "reject"];
const steerInput = (requestId: string) => ({
    content: "hello",
    mode: "followUp" as const,
    actor: steerActor,
    requestId,
});

async function park(host: HarnessHost, conversationId: string): Promise<void> {
    await internalHarness(host).commit(async (tx) => {
        const meta = await tx.doc(conversationMetaDoc, Number(conversationId) as never);
        meta.parked = { waitingFor: "reports", continueOn: "each" } as never;
    }, BACKGROUND_CONTEXT);
}

async function steerEntries(host: HarnessHost, conversationId: string) {
    const conversation = await internalHarness(host).conversation(Number(conversationId) as never, BACKGROUND_CONTEXT);
    const page = await conversation?.entries({ order: "descending" }, 50, undefined, BACKGROUND_CONTEXT);
    return (page?.items ?? []).filter((entry) => entry.kind === STEER_RECORD_KIND);
}

describe("submitInput to a closed conversation", () => {
    for (const busyMode of BUSY_MODES) {
        it(`throws ConversationClosedError and admits nothing with busy mode ${busyMode}`, async () => {
            const { host, lead } = await openHostFixture();
            const id = await lead("job-1");
            await abortJobConversations(host, "job-1");

            await assert.rejects(
                submitInput(host, id, { content: "hi", requestId: "r1", busyMode }),
                ConversationClosedError,
            );
            assert.equal((await host.conversationInfo(id))?.busy, false);
        });
    }
});

describe("steering a closed conversation", () => {
    it("throws ConversationClosedError from steerConversation and writes no steer entry", async () => {
        const { host, lead } = await openHostFixture();
        const id = await lead("job-1");
        await abortJobConversations(host, "job-1");

        await assert.rejects(steerConversation(host, id, steerInput("s1")), ConversationClosedError);

        assert.equal((await steerEntries(host, id)).length, 0);
    });

    it("throws ConversationClosedError from holdForParked and holds nothing", async () => {
        const { host, lead } = await openHostFixture();
        const id = await lead("job-1");
        await abortJobConversations(host, "job-1");
        await park(host, id);

        await assert.rejects(holdForParked(host, id, steerInput("s1")), ConversationClosedError);

        assert.equal((await steerEntries(host, id)).length, 0);
        assert.deepEqual((await readConversationMeta(host, id))?.held, []);
    });
});

describe("input while the job is Done and the closed marks are not committed", () => {
    it("refuses submitInput, steerConversation and holdForParked with ConversationClosedError", async () => {
        const { host, lead } = await openHostFixture();
        const id = await lead("job-1");
        setJobDoneCheck(host, async (jobId) => jobId === "job-1");
        await park(host, id);

        await assert.rejects(
            submitInput(host, id, { content: "hi", requestId: "r1", busyMode: "followUp" }),
            ConversationClosedError,
        );
        await assert.rejects(steerConversation(host, id, steerInput("s1")), ConversationClosedError);
        await assert.rejects(holdForParked(host, id, steerInput("s2")), ConversationClosedError);
    });
});

describe("input to the front desk after every job is Done", () => {
    it("admits the input", async () => {
        const { host, frontDesk } = await openHostFixture();
        const id = await frontDesk();
        setJobDoneCheck(host, async () => true);

        const { submissionId } = await submitInput(host, id, { content: "hi", requestId: "r1", busyMode: "followUp" });

        await waitFor(async () => (await submissionState(host, submissionId)).state === "done", "the desk's run");
    });
});

describe("a submit held in the section while the job is cancelled", () => {
    it("settles unanswered or is refused, and the lead runs no model turn after the cancel", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const fake: FauxProviderRegistration = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
        let modelCalls = 0;
        fake.setResponses([
            async () => {
                modelCalls += 1;
                return fauxAssistantMessage("done");
            },
        ]);
        fakes.push(fake);
        const provider = fake.getModel().provider;
        await writeFile(
            join(env.piAgentDir, "settings.json"),
            JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
        );
        const agents = await createAgentsComponent({ logger: quietLogger });
        const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
        let ctx: ServiceContext | undefined;
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
            components: [
                agents.component,
                jobs.component,
                {
                    name: "probe",
                    start: async (context) => {
                        ctx = context;
                    },
                },
            ],
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
        await waitFor(async () => daemon.phase() === "ready", "the daemon");
        const running = ctx as ServiceContext;
        const job = (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as {
            id: string;
            leadConversation: string;
        };
        await waitFor(
            async () => (await running.host.conversationInfo(job.leadConversation))?.busy === false,
            "idle lead",
        );
        const callsBeforeSubmit = modelCalls;
        const reached = gate();
        const held = gate();
        setSectionHook(running.host, async () => {
            reached.open();
            await held.opened;
        });

        const submitting = submitInput(running.host, job.leadConversation, {
            content: "late",
            requestId: "late-1",
            busyMode: "followUp",
        }).then(
            (result) => result,
            (error: unknown) => error,
        );
        await reached.opened;
        const cancelling = cancelJob({ ctx: running, options: jobs.options }, job.id, "stop", author);
        await pause(SETTLE_PAUSE_MS);
        held.open();
        const outcome = await submitting;
        await cancelling;
        await pause(SETTLE_PAUSE_MS);

        if (outcome instanceof Error) {
            assert.ok(outcome instanceof ConversationClosedError, String(outcome));
        } else {
            const state = await submissionState(running.host, (outcome as { submissionId: string }).submissionId);
            assert.equal(state.state, "unanswered");
        }
        assert.equal(modelCalls, callsBeforeSubmit, "the lead ran no model turn after the cancel");
    });
});
