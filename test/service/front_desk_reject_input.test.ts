/**
 * A reject input to the front desk (S-001 REQ-023, S-002 AC-012.2, ADR-004 decision 5): it records its sender and way
 * in like every other team member input, so a job the desk creates gets the letter of that way in; while the desk is
 * busy it is refused and places nothing.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const MAKE_A_JOB = "make a job";
const HOLD_THE_RUN = "hold the run";
const HOLD_MS = 60_000;
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const webInterface: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
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

const lastUserText = (transcript: FakeTranscript) => transcript.findLast((entry) => entry.role === "user")?.text ?? "";

// The desk calls create_job once for a make-a-job input; a held run waits until it is aborted; anything else answers.
function reply(transcript: FakeTranscript) {
    const hasResult = transcript.some((entry) => entry.role === "toolResult");
    if (lastUserText(transcript).includes(MAKE_A_JOB) && !hasResult) {
        return { toolCall: { name: "create_job", arguments: { text: "renew the cert" } } };
    }
    return "ok";
}

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(reply, {
        delayMs: (transcript) => (lastUserText(transcript).includes(HOLD_THE_RUN) ? HOLD_MS : 0),
    });
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, jobs.component, desk.component],
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
    const invoke = (name: string, input: unknown, caller: Caller = commandLine) =>
        daemon.catalogue.invoke(name, input, caller);
    const deskId = ((await invoke("desk.get", {})) as { conversationId: string }).conversationId;
    const entriesOf = async () =>
        (
            (await invoke("conversations.entries", { conversationId: deskId, limit: 200 })) as {
                entries: { kind: string; data: unknown }[];
            }
        ).entries;
    const send = async (caller: Caller, content: string, requestId: string, busyMode: string) =>
        (await invoke("conversations.submit", { conversationId: deskId, content, requestId, busyMode }, caller)) as {
            submissionId: string;
        };
    const settle = async (submissionId: string) => invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS });
    const jobNumbers = async () =>
        ((await invoke("jobs.list", {})) as { jobs: { number: string }[] }).jobs.map((job) => job.number).sort();
    return { invoke, deskId, entriesOf, send, settle, jobNumbers };
}

describe("a reject input to the front desk", { timeout: TEST_TIMEOUT_MS }, () => {
    it("records its sender and way in as a follow-up steer record on an idle desk", async () => {
        const fixture = await start();

        const { submissionId } = await fixture.send(commandLine, "hello", "reject-hello", "reject");
        await fixture.settle(submissionId);

        const steers = (await fixture.entriesOf()).filter((entry) => entry.kind === STEER_RECORD_KIND);
        assert.equal(steers.length, 1);
        assert.deepEqual(steers[0]?.data, {
            actor: { kind: "team_member", wayIn: "command line" },
            mode: "followUp",
            content: "hello",
        });
    });

    it("lets create_job number a job C-1 when the reject input is the desk's first input", async () => {
        const fixture = await start();

        const { submissionId } = await fixture.send(commandLine, MAKE_A_JOB, "reject-first", "reject");
        await fixture.settle(submissionId);

        assert.deepEqual(await fixture.jobNumbers(), ["C-1"]);
    });

    it("numbers a job C-n for a command line reject input after earlier web input", async () => {
        const fixture = await start();
        const web = await fixture.send(webInterface, "hello from the web", "web-hello", "followUp");
        await fixture.settle(web.submissionId);

        const { submissionId } = await fixture.send(commandLine, MAKE_A_JOB, "reject-after-web", "reject");
        await fixture.settle(submissionId);

        assert.deepEqual(await fixture.jobNumbers(), ["C-1"]);
    });

    it("is refused busy while the desk runs and places nothing", async () => {
        const fixture = await start();
        await fixture.send(commandLine, HOLD_THE_RUN, "hold", "followUp");
        await until(
            async () =>
                ((await fixture.invoke("conversations.get", { conversationId: fixture.deskId })) as { status: string })
                    .status === "running",
            "the desk to run",
        );
        const entriesBefore = (await fixture.entriesOf()).length;

        await assert.rejects(
            fixture.send(commandLine, "too late", "reject-busy", "reject"),
            (error) => error instanceof ServiceError && error.code === "busy",
        );
        await fixture.invoke("conversations.abort", { conversationId: fixture.deskId });
        await until(
            async () =>
                ((await fixture.invoke("conversations.get", { conversationId: fixture.deskId })) as { status: string })
                    .status !== "running",
            "the desk to stop",
        );

        const entries = await fixture.entriesOf();
        assert.ok(entries.length >= entriesBefore);
        assert.equal(JSON.stringify(entries).includes("too late"), false);
    });

    it("is admitted once when repeated with one request id", async () => {
        const fixture = await start();

        const first = await fixture.send(commandLine, "hello", "reject-twice", "reject");
        await fixture.settle(first.submissionId);
        const repeat = await fixture.send(commandLine, "hello", "reject-twice", "reject");

        assert.equal(repeat.submissionId, first.submissionId);
        const steers = (await fixture.entriesOf()).filter((entry) => entry.kind === STEER_RECORD_KIND);
        assert.equal(steers.length, 1);
    });
});
