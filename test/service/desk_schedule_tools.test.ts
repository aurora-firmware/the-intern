/**
 * The front desk's schedule tools (S-007 AC-013.1 to AC-013.3, S-001 REQ-022): a team member's request to the front
 * desk makes, changes, removes or runs a schedule entry through the same operations as `bob schedules`, and a lead
 * conversation reads only the history of an entry.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
import { steerConversation } from "../../src/host/steering.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createSchedulesComponent } from "../../src/schedules/schedules_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { runBob } from "../support/bob_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const SCRIPT_INPUT = "script";
const NAME = "backups-check";
const REQUEST = "Check that the backups ran.";
const SCHEDULE_TOOLS = [
    "list_schedules",
    "read_schedule_runs",
    "create_schedule",
    "change_schedule",
    "remove_schedule",
    "run_schedule",
];
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const email: Caller = { actor: { kind: "team_member", wayIn: "email" } };

type Call = { name: string; arguments: Record<string, unknown>; id?: string };
type Seen = { text: string; isError: boolean };
type ModelContext = Parameters<FauxResponseFactory>[0];
type Entry = { name: string; cron: string; request: string };
type Job = { id: string; number: string; request: { origin: Record<string, unknown> }; leadConversation: string };

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

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let script: Call[] = [];
    let step = 0;
    let seen: Seen[] = [];
    let deskOffered: string[] = [];
    let leadOffered: string[] = [];
    let reply = "finished";
    // Only the front desk's run follows the script; every other conversation answers "done".
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        const isScripted = context.messages.some(
            (message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT,
        );
        if (!isScripted) {
            leadOffered = toolNamesOf(context);
            return fauxAssistantMessage("done");
        }
        deskOffered = toolNamesOf(context);
        const results = context.messages.flatMap((message) =>
            message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
        );
        seen = results.slice(results.length - step);
        const call = script[step];
        step += 1;
        if (call === undefined) return fauxAssistantMessage(reply);
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
    const schedules = await createSchedulesComponent({ agents, jobs, logger: quietLogger });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, ...schedules.sections],
        components: [
            agents.component,
            jobs.component,
            desk.component,
            schedules.component,
            createLocalSocketComponent(),
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations, ...schedules.operations],
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
    const isIdle = async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false;
    let turn = 0;
    // The front desk's model makes `calls` in one run, begun by `begin`: a team member's input unless a test says not.
    async function run(calls: Call[], answer = "finished", begin: "team member" | "agent" = "team member") {
        script = calls;
        step = 0;
        reply = answer;
        turn += 1;
        const requestId = `script-${turn}`;
        if (begin === "agent") {
            const actor = { kind: "agent" as const, conversationId: "9999", role: "gp" };
            await steerConversation(ctx.host, deskId, { content: SCRIPT_INPUT, mode: "followUp", actor, requestId });
            await until(() => isIdle(deskId), "the front desk's run to end");
            return seen;
        }
        const input = { conversationId: deskId, content: SCRIPT_INPUT, requestId };
        const { submissionId } = (await invoke("conversations.submit", input)) as { submissionId: string };
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as { state: string };
        assert.equal(waited.state, "done");
        return seen;
    }
    const entries = async () => ((await invoke("schedules.list", {})) as { schedules: Entry[] }).schedules;
    const create = (name = NAME) => invoke("schedules.create", { name, cron: "0 2 * * *", request: REQUEST });
    const lastReply = async () => {
        const read = (await ctx.host.readEntries(deskId, { limit: 500 })).entries;
        return JSON.stringify(read.at(-1)?.data ?? "");
    };
    return {
        env,
        invoke,
        run,
        deskId,
        ctx,
        isIdle,
        entries,
        create,
        lastReply,
        deskOffered: () => deskOffered,
        leadOffered: () => leadOffered,
    };
}

const jsonOf = (result: Seen | undefined) => JSON.parse(result?.text ?? "null");
const CREATE_CALL = { name: "create_schedule", arguments: { name: NAME, cron: "0 2 * * *", request: REQUEST } };

describe("the front desk's schedule tools", { timeout: TEST_TIMEOUT_MS }, () => {
    it("creates an entry that is held in the file and in bob schedules list, and the reply names it", async () => {
        const fixture = await start();

        const results = await fixture.run([{ ...CREATE_CALL, id: "call-create" }], `I scheduled ${NAME}.`);

        assert.equal(results[0]?.isError, false);
        assert.equal(jsonOf(results[0]).schedule.name, NAME);
        const file = await readFile(join(fixture.env.configDir, "config.toml"), "utf8");
        assert.ok(file.includes(NAME), file);
        const listed = await runBob(["schedules", "list"], {
            runtimeDir: fixture.env.runtimeDir,
            env: fixture.env.env,
        });
        assert.equal(listed.status, 0, listed.stderr);
        assert.ok(listed.stdout.includes(NAME), listed.stdout);
        assert.ok((await fixture.lastReply()).includes(NAME));
    });

    it("lists the entries and reads the history of one", async () => {
        const fixture = await start();
        await fixture.create();

        const results = await fixture.run([
            { name: "list_schedules", arguments: {} },
            { name: "read_schedule_runs", arguments: { name: NAME } },
        ]);

        assert.equal(results[0]?.isError, false);
        assert.deepEqual(
            jsonOf(results[0]).schedules.map((entry: Entry) => entry.name),
            [NAME],
        );
        assert.equal(results[1]?.isError, false);
        assert.deepEqual(jsonOf(results[1]).items, []);
    });

    it("offers the front desk all six schedule tools and a lead only read_schedule_runs", async () => {
        const fixture = await start();
        await fixture.invoke("jobs.create", { text: "do it" }, email);

        await fixture.run([]);
        await until(async () => fixture.leadOffered().length > 0, "the lead's first run");

        const deskSchedule = fixture.deskOffered().filter((name) => SCHEDULE_TOOLS.includes(name));
        assert.deepEqual(deskSchedule.sort(), [...SCHEDULE_TOOLS].sort());
        const leadSchedule = fixture.leadOffered().filter((name) => SCHEDULE_TOOLS.includes(name));
        assert.deepEqual(leadSchedule, ["read_schedule_runs"]);
    });

    it("runs an entry on demand as a job whose origin records the entry, the way in and the front desk", async () => {
        const fixture = await start();
        await fixture.create();

        const results = await fixture.run([{ name: "run_schedule", arguments: { name: NAME }, id: "call-run" }]);

        assert.equal(results[0]?.isError, false);
        const job = jsonOf(results[0]) as Job;
        assert.match(job.number, /^S-\d+$/);
        const { origin } = job.request;
        assert.equal(origin.kind, "schedule");
        assert.equal(origin.entry, NAME);
        assert.deepEqual(origin.onDemand, { wayIn: "command line", frontDesk: fixture.deskId });
    });

    it("acts once for a repeated call id and returns the first result, for every tool that acts", async () => {
        const fixture = await start();

        const created = await fixture.run([{ ...CREATE_CALL, id: "same-create" }]);
        await fixture.run([{ ...CREATE_CALL, id: "same-create" }]);
        await fixture.run([
            { name: "change_schedule", arguments: { name: NAME, cron: "0 3 * * *" }, id: "same-change" },
        ]);
        const changed = await fixture.run([
            { name: "change_schedule", arguments: { name: NAME, cron: "0 4 * * *" }, id: "same-change" },
        ]);
        const first = await fixture.run([{ name: "run_schedule", arguments: { name: NAME }, id: "same-run" }]);
        const second = await fixture.run([{ name: "run_schedule", arguments: { name: NAME }, id: "same-run" }]);
        await fixture.run([{ name: "remove_schedule", arguments: { name: NAME }, id: "same-remove" }]);
        await fixture.create();
        const removed = await fixture.run([{ name: "remove_schedule", arguments: { name: NAME }, id: "same-remove" }]);

        assert.equal(created[0]?.isError, false);
        assert.equal(jsonOf(changed[0]).schedule.cron, "0 3 * * *");
        assert.equal(jsonOf(second[0]).id, jsonOf(first[0]).id);
        assert.equal(removed[0]?.isError, false);
        assert.deepEqual(
            (await fixture.entries()).map((entry) => entry.name),
            [NAME],
            "the second remove acted on nothing",
        );
        assert.equal((await fixture.ctx.jobStore.listJobs({ letter: "S" })).jobs.length, 1);
    });

    it("returns an error result for a refused operation and the run goes on", async () => {
        const fixture = await start();
        await fixture.create();

        const results = await fixture.run([
            { name: "create_schedule", arguments: { name: NAME, cron: "0 2 * * *", request: "A different request." } },
            { name: "create_schedule", arguments: { name: "bad", cron: "not a cron", request: REQUEST } },
            { name: "change_schedule", arguments: { name: "missing", request: "x" } },
            { name: "remove_schedule", arguments: { name: "missing" } },
            { name: "run_schedule", arguments: { name: "missing" } },
            { name: "read_schedule_runs", arguments: { name: "missing" } },
            { name: "list_schedules", arguments: {} },
        ]);

        assert.deepEqual(
            results.map((result) => result.isError),
            [true, true, true, true, true, true, false],
        );
        assert.match(results[2]?.text ?? "", /missing/);
    });

    it("refuses the tools that act while no team member has written to the front desk", async () => {
        const fixture = await start();

        const results = await fixture.run(
            [
                CREATE_CALL,
                { name: "change_schedule", arguments: { name: NAME, request: "x" } },
                { name: "remove_schedule", arguments: { name: NAME } },
                { name: "run_schedule", arguments: { name: NAME } },
                { name: "list_schedules", arguments: {} },
            ],
            "finished",
            "agent",
        );

        assert.deepEqual(
            results.map((result) => result.isError),
            [true, true, true, true, false],
        );
        assert.match(results[0]?.text ?? "", /no team member has written/);
        assert.deepEqual(await fixture.entries(), []);
    });
});
