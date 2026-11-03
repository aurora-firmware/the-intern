/**
 * The front-desk job tools (S-004 AC-021.1 to AC-021.3, S-001 AC-022.2, AC-022.3, AC-023.2): the front desk's model
 * names the jobs it acts on, and a job it creates takes the way in of the team member's input, over the local socket
 * and over the network listener.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
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
import { readConversationMeta } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const LOOPBACK = "127.0.0.1";
const SCRIPT_INPUT = "script";
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const email: Caller = { actor: { kind: "team_member", wayIn: "email" } };

type Listener = "local socket" | "network listener";
type Call = { name: string; arguments: Record<string, unknown>; id?: string };
type Seen = { text: string; isError: boolean };
type ModelContext = Parameters<FauxResponseFactory>[0];
type JobResult = {
    id: string;
    number: string;
    description?: string;
    related: string[];
    request: { origin: unknown };
    leadConversation: string;
    history: { author: unknown; field?: string }[];
    worklog: { text: string; author: unknown }[];
};

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

function post(target: object, name: string, input: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const options = { ...target, method: "POST", path: `/operations/${name}` };
        const call = request({ ...options, headers: { "content-type": "application/json" } }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: unknown };
                if (response.statusCode !== 200) reject(new Error(`${name} answered ${response.statusCode}`));
                resolve(body.result);
            });
            response.once("error", reject);
        });
        call.once("error", reject);
        call.end(JSON.stringify(input));
    });
}

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let script: Call[] = [];
    let step = 0;
    let seen: Seen[] = [];
    // Only the front desk's run follows the script; every job's lead answers "done".
    const respond: FauxResponseFactory = async (context: ModelContext) => {
        fake.appendResponses([respond]);
        const isScripted = context.messages.some(
            (message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT,
        );
        if (!isScripted) return fauxAssistantMessage("done");
        const results = context.messages.flatMap((message) =>
            message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
        );
        seen = results.slice(results.length - step);
        const call = script[step];
        step += 1;
        if (call === undefined) return fauxAssistantMessage("finished");
        const options = call.id === undefined ? undefined : { id: call.id };
        return fauxAssistantMessage([fauxToolCall(call.name, call.arguments as never, options)], {
            stopReason: "toolUse",
        });
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    await writeFile(join(env.configDir, "config.toml"), `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    const network = createNetworkListenerComponent({ freePort: true });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, networkSection],
        components: [
            agents.component,
            jobs.component,
            desk.component,
            createLocalSocketComponent(),
            network,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
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
    const socketPath = localSocketPath(env.runtimeDir);
    const call = (listener: Listener, name: string, input: unknown) => {
        const address = network.address();
        assert.ok(address, "the network listener is running");
        return post(listener === "local socket" ? { socketPath } : address, name, input);
    };
    const invoke = (name: string, input: unknown, caller: Caller = commandLine) =>
        daemon.catalogue.invoke(name, input, caller);
    const deskId = ((await invoke("desk.get", {})) as { conversationId: string }).conversationId;
    let turn = 0;
    // The front desk's model makes `calls` in one run begun by a team member's input over the listener.
    async function run(listener: Listener, calls: Call[]): Promise<Seen[]> {
        script = calls;
        step = 0;
        turn += 1;
        const input = { conversationId: deskId, content: SCRIPT_INPUT, requestId: `script-${turn}` };
        const { submissionId } = (await call(listener, "conversations.submit", input)) as { submissionId: string };
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as { state: string };
        assert.equal(waited.state, "done");
        return seen;
    }
    const ctx = captured as ServiceContext;
    const read = (job: string) => invoke("jobs.get", { job }) as Promise<JobResult>;
    return { invoke, run, deskId, ctx, read };
}

const jsonOf = (result: Seen | undefined) => JSON.parse(result?.text ?? "null");

describe("the front-desk job tools", { timeout: TEST_TIMEOUT_MS }, () => {
    it("creates one C job for a command line input, once per call id, and a W job for a network input", async () => {
        const fixture = await start();
        const create = { name: "create_job", arguments: { text: "renew the cert" }, id: "call-cert" };

        const first = jsonOf((await fixture.run("local socket", [create]))[0]);
        const repeat = jsonOf((await fixture.run("local socket", [create]))[0]);
        const web = jsonOf((await fixture.run("network listener", [{ ...create, id: "call-web" }]))[0]);

        assert.match(first.number, /^C-[1-9][0-9]*$/);
        assert.equal(repeat.number, first.number);
        assert.match(web.number, /^W-[1-9][0-9]*$/);
        const jobs = (await fixture.invoke("jobs.list", {})) as { jobs: unknown[] };
        assert.equal(jobs.jobs.length, 2);
        const stored = await fixture.read(first.number);
        assert.deepEqual(stored.request.origin, {
            kind: "request",
            wayIn: "command line",
            frontDesk: fixture.deskId,
        });
        assert.deepEqual(stored.related, []);
        assert.equal((await readConversationMeta(fixture.ctx.host, stored.leadConversation))?.seat.role, "bob");
    });

    it("lists the jobs jobs.list returns for the same filter, in the same order", async () => {
        const fixture = await start();
        const blockedEmail = (await fixture.invoke("jobs.create", { text: "mail one" }, email)) as JobResult;
        await fixture.invoke("jobs.create", { text: "mail two" }, email);
        await fixture.invoke("jobs.create", { text: "from the command line" });
        await fixture.ctx.jobStore.applyAction(
            blockedEmail.id,
            "block",
            { blockedReason: "needs an answer" },
            { kind: "daemon" },
        );

        const filtered = await fixture.run("local socket", [
            { name: "list_jobs", arguments: { status: "blocked", letter: "E" } },
            { name: "list_jobs", arguments: {} },
        ]);

        const expectedFiltered = await fixture.invoke("jobs.list", { status: "blocked", letter: "E" });
        const expectedAll = await fixture.invoke("jobs.list", {});
        assert.deepEqual(jsonOf(filtered[0]), JSON.parse(JSON.stringify(expectedFiltered)));
        assert.equal(jsonOf(filtered[0]).jobs.length, 1);
        assert.deepEqual(jsonOf(filtered[1]), JSON.parse(JSON.stringify(expectedAll)));
        assert.equal(jsonOf(filtered[1]).jobs.length, 3);
    });

    it("updates, adds a worklog entry and relates a job by number, authored by the front desk", async () => {
        const fixture = await start();
        const target = (await fixture.invoke("jobs.create", { text: "seven" })) as JobResult;
        const other = (await fixture.invoke(
            "jobs.create",
            { text: "nine" },
            { actor: { kind: "team_member", wayIn: "web interface" } },
        )) as JobResult;

        const results = await fixture.run("network listener", [
            { name: "update_job", arguments: { job: target.number, description: "new plan" } },
            { name: "add_worklog", arguments: { job: target.number, text: "asked the team" } },
            { name: "relate_jobs", arguments: { job: target.number, other: other.number } },
            { name: "read_job", arguments: { job: target.number } },
        ]);

        assert.deepEqual(
            results.map((result) => result.isError),
            [false, false, false, false],
        );
        const stored = await fixture.read(target.id);
        const author = { kind: "agent", conversationId: fixture.deskId, role: "desk" };
        assert.equal(stored.description, "new plan");
        assert.deepEqual(stored.related, [other.number]);
        assert.deepEqual(
            stored.worklog.map((entry) => [entry.text, entry.author]),
            [["asked the team", author]],
        );
        assert.deepEqual(stored.history.find((entry) => entry.field === "description")?.author, author);
        assert.equal(jsonOf(results[3]).number, target.number);
    });

    it("returns an error result for a job that does not exist and lets the run go on", async () => {
        const fixture = await start();

        const results = await fixture.run("local socket", [
            { name: "read_job", arguments: { job: "C-999" } },
            { name: "update_job", arguments: { job: "C-999", title: "x" } },
            { name: "add_worklog", arguments: { job: "C-999", text: "x" } },
            { name: "relate_jobs", arguments: { job: "C-999", other: "C-998" } },
            { name: "list_jobs", arguments: {} },
        ]);

        assert.equal(results.length, 5);
        assert.deepEqual(
            results.map((result) => result.isError),
            [true, true, true, true, false],
        );
        assert.match(results[0]?.text ?? "", /C-999/);
    });
});
