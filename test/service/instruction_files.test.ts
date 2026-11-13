/** A team role whose instruction file is missing or empty is not seated (S-008 REQ-007: AC-007.3, AC-007.5). */
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    fauxAssistantMessage,
    fauxToolCall,
    type JsonObject,
    type Message,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createSeatedConversation, readConversationMeta } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { roleInstructionPath } from "../../src/skills/internal_folder.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const FILE = "instructions/roles/reviewer.md";

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const textOf = (message: Message | undefined): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};

/** The model's first request in a lead holds until `release()`, then makes `leadCall` once and finishes. */
async function start(leadCall?: { tool: string; args: JsonObject }) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const toolResults: { text: string; isError: boolean }[] = [];
    let release = (): void => {};
    const isHeld = new Promise<void>((resolve) => {
        release = resolve;
    });
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        const results = context.messages.filter((message) => message.role === "toolResult");
        if (results.length > 0) {
            for (const result of results) {
                toolResults.push({ text: textOf(result), isError: result.role === "toolResult" && result.isError });
            }
            return fauxAssistantMessage("done");
        }
        if (leadCall === undefined) return fauxAssistantMessage("done");
        await isHeld;
        return fauxAssistantMessage([fauxToolCall(leadCall.tool, leadCall.args)], { stopReason: "toolUse" });
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
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
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const ctx = captured as ServiceContext;
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, caller);
    await invoke("roles.create", { name: "reviewer", instructions: "Review the work.", tools: ["read"], skills: [] });
    return {
        ctx,
        toolResults,
        release,
        invoke,
        dataDir: env.dataDir,
        instructionFile: roleInstructionPath(env.dataDir, "reviewer"),
        agents,
    };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const refusal = async (action: Promise<unknown>): Promise<{ code: string; message: string }> => {
    try {
        await action;
    } catch (error) {
        return error as { code: string; message: string };
    }
    throw new Error("expected the operation to be refused");
};

const removals = [
    ["deleted", (file: string) => rm(file)],
    ["empty", (file: string) => writeFile(file, "")],
    ["white space only", (file: string) => writeFile(file, " \n\t\n")],
] as const;

describe("a team role whose instruction file is missing or empty", () => {
    for (const [state, damage] of removals) {
        it(`is refused by conversations.seat naming the file when it is ${state} (AC-1)`, async () => {
            const started = await start();
            const seat = started.agents.runtime().catalog.seatFor("gp");
            const { conversationId } = await createSeatedConversation(started.ctx.host, {
                scope: "test",
                key: "conversation-1",
                job: { jobId: "job-1", isLead: false, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat,
                actor: { kind: "team_member", wayIn: "cli" },
            });
            await damage(started.instructionFile);

            const error = await refusal(started.invoke("conversations.seat", { conversationId, role: "reviewer" }));

            assert.equal(error.code, "invalid_input");
            assert.ok(error.message.includes(FILE), error.message);
            assert.equal((await readConversationMeta(started.ctx.host, conversationId))?.seat.role, "gp");
        });

        it(`is refused by jobs.create naming the file, and no job is created, when it is ${state} (AC-2)`, async () => {
            const started = await start();
            await damage(started.instructionFile);

            const error = await refusal(started.invoke("jobs.create", { text: "work", role: "reviewer" }));

            assert.equal(error.code, "invalid_input");
            assert.ok(error.message.includes(FILE), error.message);
            assert.deepEqual((await started.ctx.jobStore.listJobs({})).jobs, []);
        });
    }

    it("is refused by a handoff with an error result naming the file, and the agent keeps its seat (AC-3)", async () => {
        const started = await start({ tool: "handoff", args: { role: "reviewer", contextMode: "full" } });
        const job = (await started.invoke("jobs.create", { text: "work" })) as { leadConversation: string };
        await rm(started.instructionFile);
        started.release();

        await waitFor(() => started.toolResults.length > 0, "the error result");

        const [result] = started.toolResults;
        assert.equal(result?.isError, true);
        assert.ok(result?.text.includes(FILE), result?.text);
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.seat.role, "bob");
    });

    it("is refused by an invocation with an error result naming the file, and the agent keeps its seat (AC-3)", async () => {
        const started = await start({
            tool: "invoke",
            args: {
                agents: [{ role: "reviewer", contextMode: "clean", jobPrompt: "look" }],
                // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
                then: "steerable",
            },
        });
        const job = (await started.invoke("jobs.create", { text: "work" })) as { leadConversation: string };
        await rm(started.instructionFile);
        started.release();

        await waitFor(() => started.toolResults.length > 0, "the error result");

        const [result] = started.toolResults;
        assert.equal(result?.isError, true);
        assert.ok(result?.text.includes(FILE), result?.text);
        assert.equal((await readConversationMeta(started.ctx.host, job.leadConversation))?.seat.role, "bob");
        assert.equal((await started.ctx.host.listConversations()).length, 1);
    });

    it("leaves a shipped role's missing file out of the seat instead of refusing it (AC-007.5)", async () => {
        const started = await start();
        await rm(roleInstructionPath(started.dataDir, "gp"));

        assert.equal(started.agents.runtime().catalog.seatFor("gp").instructions, "");
    });
});
