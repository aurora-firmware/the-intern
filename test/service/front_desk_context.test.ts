/**
 * The front desk's context, reset and worker threads (S-001 AC-021.6, AC-024.1, AC-024.2, AC-025.3): pi-durable's
 * automatic compaction keeps its context within the model's window, `conversations.reset` clears the context and keeps
 * the seat, its runs take worker threads in arrival order, and removing `desk` leaves it unchanged.
 */
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
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const SMALL_CONTEXT_WINDOW = 2_000;
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

type ModelContext = Parameters<FauxResponseFactory>[0];
type ModelCall = { lastUser: string; userTexts: string[]; summaryRequest: boolean };
type FixtureOptions = { contextWindow?: number; workerThreadCount?: number; compaction?: object };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

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

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

function gate() {
    let release = (): void => {};
    const opened = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { opened, release };
}

async function start(options: FixtureOptions = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({
        models: [{ id: "model-one", reasoning: true, contextWindow: options.contextWindow ?? 128_000 }],
    });
    fakes.push(fake);
    const calls: ModelCall[] = [];
    const heldBy = new Map<string, Promise<void>>();
    const toolRequests = new Map<string, string>();
    const results: { text: string; isError: boolean }[] = [];
    // Every run answers "ok" at once, except a run whose last message is held by `hold`.
    const respond: FauxResponseFactory = async (context: ModelContext) => {
        fake.appendResponses([respond]);
        const users = context.messages.flatMap((message) => (message.role === "user" ? [textOf(message.content)] : []));
        const lastUser = users.at(-1) ?? "";
        calls.push({
            lastUser,
            userTexts: users,
            summaryRequest: lastUser.includes("<conversation>"),
        });
        for (const [fragment, opened] of heldBy) if (lastUser.includes(fragment)) await opened;
        const hasToolResult = context.messages.some((message) => message.role === "toolResult");
        const requestedTool = [...toolRequests].find(([fragment]) => lastUser.includes(fragment));
        if (requestedTool && !hasToolResult) {
            return fauxAssistantMessage([fauxToolCall(requestedTool[1], {})], { stopReason: "toolUse" });
        }
        results.push(
            ...context.messages.flatMap((message) =>
                message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
            ),
        );
        return fauxAssistantMessage("ok");
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one", compaction: options.compaction }),
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
        ...(options.workerThreadCount === undefined ? {} : { workerThreadCount: options.workerThreadCount }),
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
    const getDesk = () => invoke("desk.get", {}) as Promise<{ conversationId: string; seat: unknown }>;
    const deskId = (await getDesk()).conversationId;
    const entriesOf = async (conversationId: string) =>
        (
            (await invoke("conversations.entries", { conversationId, limit: 500 })) as {
                entries: { kind: string; data: unknown }[];
            }
        ).entries;
    const submitToDesk = async (content: string) =>
        (await invoke("conversations.submit", {
            conversationId: deskId,
            content,
            requestId: `${content}-request`,
        })) as {
            submissionId: string;
        };
    const talkToDesk = async (content: string) => {
        const { submissionId } = await submitToDesk(content);
        const waited = (await invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as { state: string };
        assert.equal(waited.state, "done");
    };
    const workerThreads = async () =>
        (
            (await invoke("daemon.status", {})) as {
                workerThreads: { inUse: number; waiting: { conversationId: string; position: number }[] };
            }
        ).workerThreads;
    const hold = (lastUser: string) => {
        const held = gate();
        heldBy.set(lastUser, held.opened);
        return held.release;
    };
    // A run whose last message holds `fragment` calls the tool `name` once, with no arguments.
    const requestTool = (fragment: string, name: string) => toolRequests.set(fragment, name);
    return {
        invoke,
        requestTool,
        results,
        getDesk,
        deskId,
        entriesOf,
        talkToDesk,
        submitToDesk,
        workerThreads,
        hold,
        calls,
    };
}

describe("the front desk's context", { timeout: TEST_TIMEOUT_MS }, () => {
    it("compacts by itself near the window, starts the next context from the summary and answers", async () => {
        const fixture = await start({
            contextWindow: SMALL_CONTEXT_WINDOW,
            compaction: { reserveTokens: 500, keepRecentTokens: 200 },
        });
        const filler = "word ".repeat(300);

        for (const turn of ["one", "two", "three", "four"]) await fixture.talkToDesk(`${turn} ${filler}`);
        await until(
            async () => (await fixture.entriesOf(fixture.deskId)).some((entry) => entry.kind === "pi.compaction"),
            "a compaction entry",
        );
        await fixture.talkToDesk("after the compaction");

        const entries = await fixture.entriesOf(fixture.deskId);
        assert.ok(entries.some((entry) => entry.kind === "pi.compaction"));
        const last = fixture.calls.at(-1);
        assert.equal(last?.lastUser, "after the compaction");
        assert.ok(
            last.userTexts.some((text) => text.includes("<summary>")),
            "the next context starts from the summary",
        );
        assert.ok(!last.userTexts.some((text) => text.startsWith("one ")), "the earliest message left the context");
    });

    it("keeps the id, seat and earlier entries on reset, empties the next context and offers the front-desk tools", async () => {
        const fixture = await start();
        fixture.requestTool("tools after the reset", "list_jobs");
        await fixture.talkToDesk("before the reset");
        const before = await fixture.getDesk();
        const entriesBefore = await fixture.entriesOf(fixture.deskId);

        await fixture.invoke("conversations.reset", { conversationId: fixture.deskId });
        await fixture.talkToDesk("tools after the reset");

        assert.deepEqual(await fixture.getDesk(), before);
        const entries = await fixture.entriesOf(fixture.deskId);
        assert.deepEqual(entries.slice(0, entriesBefore.length), entriesBefore);
        assert.ok(entries.some((entry) => entry.kind === "pi.reset"));
        const last = fixture.calls.at(-1);
        assert.deepEqual(last?.userTexts, ["tools after the reset"]);
        assert.equal(
            fixture.results.some((result) => result.isError),
            false,
            "list_jobs is still offered",
        );
        assert.equal(fixture.results.length > 0, true, "the front desk used list_jobs");
    });
});

describe("the front desk on one worker thread", { timeout: TEST_TIMEOUT_MS }, () => {
    it("runs a new job's lead at once while idle and makes a front-desk run wait in arrival order", async () => {
        const fixture = await start({ workerThreadCount: 1 });
        const releaseFirstLead = fixture.hold("first job");

        await fixture.invoke("jobs.create", { text: "first job" });
        await until(() => fixture.calls.some((call) => call.lastUser.includes("first job")), "the first lead to run");
        assert.equal((await fixture.workerThreads()).inUse, 1);
        await fixture.submitToDesk("desk question");
        await fixture.invoke("jobs.create", { text: "second job" });

        await until(async () => (await fixture.workerThreads()).waiting.length === 2, "two runs to wait");
        const waiting = (await fixture.workerThreads()).waiting;
        assert.equal(waiting[0]?.conversationId, fixture.deskId);
        assert.deepEqual(
            waiting.map((run) => run.position),
            [1, 2],
        );
        assert.ok(!fixture.calls.some((call) => call.lastUser === "desk question"));

        releaseFirstLead();
        await until(() => fixture.calls.some((call) => call.lastUser.includes("second job")), "the second lead to run");
        const order = fixture.calls.map((call) => call.lastUser);
        const deskIndex = order.indexOf("desk question");
        assert.ok(deskIndex > -1, "the front desk ran");
        assert.ok(deskIndex < order.findIndex((text) => text.includes("second job")));
    });
});

describe("removing the desk role", { timeout: TEST_TIMEOUT_MS }, () => {
    it("is refused and leaves the front desk and its seat unchanged", async () => {
        const fixture = await start();
        const before = await fixture.getDesk();

        await assert.rejects(
            fixture.invoke("roles.remove", { name: "desk" }),
            (error) => error instanceof ServiceError && error.code === "conflict",
        );

        assert.deepEqual(await fixture.getDesk(), before);
    });
});
