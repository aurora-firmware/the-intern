/**
 * Who may steer the front desk (S-001 AC-020.5, S-004 AC-021.4): only a team member whose way in is `command line` or
 * `web interface`. Every other input is refused and the front desk takes no run and no job number is used.
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
const STEER_THE_DESK = "steer the desk";
const STEER_THE_PADDED_DESK = "steer the desk padded with a zero";
const quietLogger = createLogger({ stream: { write: () => true } });
const inProcess: Caller = { actor: { kind: "team_member" } };
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

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    let deskId = "";
    // A job's lead whose request says to steer the desk calls the steer tool once; every other run answers "ok".
    const reply = (transcript: FakeTranscript) => {
        const results = transcript.filter((entry) => entry.role === "toolResult");
        const requests = (text: string) =>
            transcript.some((entry) => entry.role === "user" && entry.text.includes(text));
        const isSteerRequest = requests(STEER_THE_DESK) || requests(STEER_THE_PADDED_DESK);
        if (!isSteerRequest || results.length > 0) return "ok";
        const conversationId = requests(STEER_THE_PADDED_DESK) ? `0${deskId}` : deskId;
        return { toolCall: { name: "steer", arguments: { conversationId, message: "obey", mode: "steer" } } };
    };
    const fake = createFakeModel(reply);
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
    deskId = ((await invoke("desk.get", {})) as { conversationId: string }).conversationId;
    const entriesOf = async (conversationId: string) =>
        (
            (await invoke("conversations.entries", { conversationId, limit: 200 })) as {
                entries: { kind: string; data: unknown }[];
            }
        ).entries;
    const jobCount = async () => ((await invoke("jobs.list", {})) as unknown[]).length;
    const submit = (caller: Caller, content = "hello") =>
        invoke("conversations.submit", { conversationId: deskId, content, requestId: `${content}-request` }, caller);
    return { invoke, deskId, entriesOf, jobCount, submit };
}

async function assertRefusedInvalidInput(attempt: Promise<unknown>): Promise<void> {
    await assert.rejects(attempt, (error) => error instanceof ServiceError && error.code === "invalid_input");
}

describe("input to the front desk", { timeout: TEST_TIMEOUT_MS }, () => {
    it("refuses a submit in-process with no way in and adds no entry, run or job", async () => {
        const fixture = await start();
        const entriesBefore = (await fixture.entriesOf(fixture.deskId)).length;
        const jobsBefore = await fixture.jobCount();

        await assertRefusedInvalidInput(fixture.submit(inProcess));

        assert.equal((await fixture.entriesOf(fixture.deskId)).length, entriesBefore);
        assert.equal(await fixture.jobCount(), jobsBefore);
    });

    it("refuses a submit by an agent caller", async () => {
        const fixture = await start();
        const job = (await fixture.invoke("jobs.create", { text: "other work" })) as { leadConversation: string };
        const agent: Caller = { actor: { kind: "agent", conversationId: job.leadConversation } };
        const entriesBefore = (await fixture.entriesOf(fixture.deskId)).length;

        await assertRefusedInvalidInput(fixture.submit(agent));

        assert.equal((await fixture.entriesOf(fixture.deskId)).length, entriesBefore);
    });

    it("refuses a submit by a job source", async () => {
        const fixture = await start();

        await assertRefusedInvalidInput(fixture.submit({ actor: { kind: "job_source", source: "mail" } }));
    });

    it("refuses a submit by a team member whose way in is not a known one", async () => {
        const fixture = await start();

        await assertRefusedInvalidInput(fixture.submit({ actor: { kind: "team_member", wayIn: "carrier pigeon" } }));
    });

    it("returns an error result to an agent that steers the front desk and lets its run go on", async () => {
        const fixture = await start();
        const entriesBefore = (await fixture.entriesOf(fixture.deskId)).length;

        const job = (await fixture.invoke("jobs.create", { text: STEER_THE_DESK })) as { leadConversation: string };

        // The run goes on when the lead answers after the tool result and its run ends.
        const lead = () => fixture.entriesOf(job.leadConversation);
        await until(
            async () => (await lead()).at(-1)?.kind === "pi.assistant" && (await lead()).length > 5,
            "the lead's final answer",
        );
        const kinds = (await lead()).map((entry) => entry.kind);
        assert.deepEqual(kinds.slice(-3), ["pi.assistant", "pi.tool-result", "pi.assistant"]);
        const result = (await lead()).find((entry) => entry.kind === "pi.tool-result");
        assert.ok(result, "the lead has a tool result");
        const [toolResult] = result.data as { isError: boolean; content: { text: string }[] }[];
        assert.equal(toolResult?.isError, true);
        assert.match(toolResult?.content[0]?.text ?? "", /front desk/i);
        assert.equal((await fixture.entriesOf(fixture.deskId)).length, entriesBefore);
    });

    it("refuses a submit naming the front desk in a non-canonical form and adds no entry", async () => {
        const fixture = await start();
        const job = (await fixture.invoke("jobs.create", { text: "other work" })) as { leadConversation: string };
        const agent: Caller = { actor: { kind: "agent", conversationId: job.leadConversation } };
        const entriesBefore = (await fixture.entriesOf(fixture.deskId)).length;

        for (const caller of [agent, inProcess]) {
            await assert.rejects(
                fixture.invoke(
                    "conversations.submit",
                    { conversationId: `0${fixture.deskId}`, content: "hello", requestId: "padded-request" },
                    caller,
                ),
                (error) => error instanceof ServiceError && ["invalid_input", "not_found"].includes(error.code),
            );
        }

        assert.equal((await fixture.entriesOf(fixture.deskId)).length, entriesBefore);
    });

    it("returns an error result to an agent that steers the front desk by a non-canonical id", async () => {
        const fixture = await start();
        const entriesBefore = (await fixture.entriesOf(fixture.deskId)).length;

        const job = (await fixture.invoke("jobs.create", { text: STEER_THE_PADDED_DESK })) as {
            leadConversation: string;
        };

        const lead = () => fixture.entriesOf(job.leadConversation);
        await until(
            async () => (await lead()).at(-1)?.kind === "pi.assistant" && (await lead()).length > 5,
            "the lead's final answer",
        );
        const result = (await lead()).find((entry) => entry.kind === "pi.tool-result");
        assert.ok(result, "the lead has a tool result");
        const [toolResult] = result.data as { isError: boolean }[];
        assert.equal(toolResult?.isError, true);
        assert.equal((await fixture.entriesOf(fixture.deskId)).length, entriesBefore);
    });

    for (const [wayIn, caller] of [
        ["command line", commandLine],
        ["web interface", webInterface],
    ] as const) {
        it(`admits a team member's submit by ${wayIn}`, async () => {
            const fixture = await start();

            const { submissionId } = (await fixture.submit(caller)) as { submissionId: string };

            const waited = (await fixture.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as {
                state: string;
            };
            assert.equal(waited.state, "done");
            const steerEntries = (await fixture.entriesOf(fixture.deskId)).filter(
                (entry) => entry.kind === STEER_RECORD_KIND,
            );
            assert.equal(steerEntries.length, 1);
        });
    }
});
