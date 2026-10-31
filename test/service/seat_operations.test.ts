import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import {
    createSeatedConversation,
    readConversationMeta,
    SEAT_RECORD_KIND,
    type SeatRecord,
} from "../../src/host/seating.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { seatActorFor } from "../../src/service/seat_operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "cli" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Started = {
    env: HermeticEnv;
    ctx: ServiceContext;
    provider: string;
    invoke(name: string, input: unknown, as?: Caller): Promise<unknown>;
    seatOperation(input: unknown, as?: Caller): Promise<unknown>;
    seatConversation(role: string, isLead?: boolean): Promise<string>;
    runTurn(conversationId: string, content: string): Promise<void>;
    records(
        conversationId: string,
    ): Promise<{ previous: unknown; next: unknown; actor: unknown; contextMode?: string }[]>;
    answers(conversationId: string): Promise<string[]>;
    folder(name: string): Promise<string>;
};

// One provider with two reasoning models. The answer names the model that gave it; a request to run `pwd` becomes a
// bash tool call, and the tool's output becomes the answer.
function registerModels(): FauxProviderRegistration {
    const registration = registerFauxProvider({
        models: [
            { id: "model-one", reasoning: true },
            { id: "model-two", reasoning: true },
        ],
    });
    const answer = async (
        context: { messages: { role: string; content: unknown }[] },
        _options: unknown,
        _state: unknown,
        model: { id: string },
    ) => {
        registration.appendResponses([answer]);
        const last = context.messages[context.messages.length - 1];
        const lastText = JSON.stringify(last?.content);
        if (last?.role === "toolResult") return fauxAssistantMessage(`tool-said ${lastText}`);
        if (lastText.includes("run pwd")) {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "tool-pwd" })], {
                stopReason: "toolUse",
            });
        }
        return fauxAssistantMessage(`from-${model.id}`);
    };
    registration.setResponses([answer]);
    return registration;
}

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerModels();
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
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
        components: [agents.component, probe],
        operations: agents.operations,
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
    let conversationCount = 0;
    const invoke = (name: string, input: unknown, as: Caller = caller) => daemon.catalogue.invoke(name, input, as);
    return {
        env,
        ctx,
        provider,
        invoke,
        seatOperation: (input, as) => invoke("conversations.seat", input, as),
        async seatConversation(role, isLead = false) {
            conversationCount += 1;
            const seat = agents.runtime().catalog.seatFor(role);
            const { conversationId } = await createSeatedConversation(ctx.host, {
                scope: "test",
                key: `conversation-${conversationCount}`,
                job: { jobId: "job-1", isLead, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat,
                actor: { kind: "team_member", wayIn: "cli" },
            });
            return conversationId;
        },
        async runTurn(conversationId, content) {
            const { submissionId } = await submitInput(ctx.host, conversationId, {
                content,
                requestId: `request-${Math.random()}`,
                busyMode: "reject",
            });
            await waitForSubmission(ctx.host, submissionId, WAIT_MS);
        },
        async records(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === SEAT_RECORD_KIND).map((entry) => entry.data) as never;
        },
        async answers(conversationId) {
            const context = await ctx.host.readContext(conversationId);
            return context.filter((entry) => entry.kind === "pi.assistant").map((entry) => JSON.stringify(entry.data));
        },
        async folder(name) {
            const path = join(env.root, name);
            await mkdir(path);
            await chmod(path, 0o700);
            await agents.runtime().workspaces.register(path);
            return path;
        },
    };
}

async function refusalCode(action: Promise<unknown>): Promise<string> {
    try {
        await action;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
        return error.code;
    }
    throw new Error("expected the operation to be refused");
}

async function createReviewerRole(started: Started, provider: string): Promise<void> {
    await started.invoke("roles.create", {
        name: "reviewer",
        instructions: "Review the work.",
        tools: ["read", "bash"],
        model: `${provider}/model-two`,
        thinkingLevel: "high",
    });
}

describe("conversations.seat", () => {
    it("runs the next turn with the new role's defaults and records the change with the way in and Full mode", async () => {
        const started = await start();
        await createReviewerRole(started, started.provider);
        const conversationId = await started.seatConversation("gp");
        await started.runTurn(conversationId, "hello");

        await started.seatOperation({ conversationId, role: "reviewer" });
        await started.runTurn(conversationId, "again");

        const answers = await started.answers(conversationId);
        assert.match(answers[0] ?? "", /from-model-one/);
        assert.match(answers[1] ?? "", /from-model-two/);
        const records = await started.records(conversationId);
        const change = records[1] as SeatRecord;
        assert.equal(change.previous?.role, "gp");
        assert.equal(change.next.role, "reviewer");
        assert.equal(change.next.thinkingLevel, "high");
        assert.deepEqual(change.actor, { kind: "team_member", wayIn: "cli" });
        assert.equal(change.contextMode, "full");
    });

    it("records a team member who names no way in as in-process", async () => {
        const started = await start();
        const conversationId = await started.seatConversation("gp");

        await started.seatOperation({ conversationId, role: "bob" }, { actor: { kind: "team_member" } });

        const records = await started.records(conversationId);
        assert.deepEqual(records[1]?.actor, { kind: "team_member", wayIn: "in-process" });
    });

    it("seats the model, thinking level and workspace the change names", async () => {
        const started = await start();
        const conversationId = await started.seatConversation("gp");
        const workspace = await started.folder("elsewhere");

        await started.seatOperation({
            conversationId,
            role: "bob",
            model: `${started.provider}/model-two`,
            thinkingLevel: "low",
            workspace,
        });
        await started.runTurn(conversationId, "hello");

        const meta = await readConversationMeta(started.ctx.host, conversationId);
        assert.equal(meta?.seat.role, "bob");
        assert.equal(meta?.seat.model, `${started.provider}/model-two`);
        assert.equal(meta?.seat.thinkingLevel, "low");
        assert.equal(meta?.seat.workspace, workspace);
        assert.match((await started.answers(conversationId))[0] ?? "", /from-model-two/);
    });

    it("refuses an unknown role, model, thinking level, workspace or conversation and leaves the seat unchanged", async () => {
        const started = await start();
        const conversationId = await started.seatConversation("gp");
        const before = await readConversationMeta(started.ctx.host, conversationId);
        const unregistered = join(started.env.root, "unregistered");

        assert.equal(await refusalCode(started.seatOperation({ conversationId, role: "nobody" })), "not_found");
        assert.equal(
            await refusalCode(started.seatOperation({ conversationId, role: "bob", model: "nowhere/none" })),
            "invalid_input",
        );
        assert.equal(
            await refusalCode(started.seatOperation({ conversationId, role: "bob", thinkingLevel: "extreme" })),
            "invalid_input",
        );
        assert.equal(
            await refusalCode(started.seatOperation({ conversationId, role: "bob", workspace: unregistered })),
            "invalid_input",
        );
        assert.equal(await refusalCode(started.seatOperation({ conversationId: "9999", role: "bob" })), "not_found");
        assert.equal(await refusalCode(started.seatOperation({ role: "bob" })), "invalid_input");

        assert.deepEqual(await readConversationMeta(started.ctx.host, conversationId), before);
        assert.equal((await started.records(conversationId)).length, 1);
    });

    it("keeps the lead conversation the job's lead conversation, seated with the new role", async () => {
        const started = await start();
        const conversationId = await started.seatConversation("bob", true);

        await started.seatOperation({ conversationId, role: "gp" });

        const meta = await readConversationMeta(started.ctx.host, conversationId);
        assert.equal(meta?.isLead, true);
        assert.equal(meta?.jobId, "job-1");
        assert.equal(meta?.seat.role, "gp");
    });

    it("keeps running the tools of a conversation in a workspace that is then unregistered until its seat changes", async () => {
        const started = await start();
        const workspace = await started.folder("temporary");
        const conversationId = await started.seatConversation("gp");
        await started.seatOperation({ conversationId, role: "gp", workspace });

        await started.invoke("workspaces.unregister", { path: workspace });
        await started.runTurn(conversationId, "run pwd");

        const answers = await started.answers(conversationId);
        assert.ok(
            answers.some((answer) => answer.includes(workspace)),
            `no answer names ${workspace}: ${answers}`,
        );
        await started.seatOperation({ conversationId, role: "gp" });
        const meta = await readConversationMeta(started.ctx.host, conversationId);
        assert.notEqual(meta?.seat.workspace, workspace);
    });
});

describe("seatActorFor", () => {
    it("names the way in of a team member, and in-process when none is named", () => {
        assert.deepEqual(seatActorFor({ actor: { kind: "team_member", wayIn: "telegram" } }), {
            kind: "team_member",
            wayIn: "telegram",
        });
        assert.deepEqual(seatActorFor({ actor: { kind: "team_member" } }), {
            kind: "team_member",
            wayIn: "in-process",
        });
    });

    it("names the role of an agent and keeps a job source as it is", () => {
        assert.deepEqual(seatActorFor({ actor: { kind: "agent", conversationId: "4" } }, "gp"), {
            kind: "agent",
            conversationId: "4",
            role: "gp",
        });
        assert.deepEqual(seatActorFor({ actor: { kind: "job_source", source: "cron" } }), {
            kind: "job_source",
            source: "cron",
        });
    });

    it("throws when an agent's role is not given", () => {
        assert.throws(() => seatActorFor({ actor: { kind: "agent", conversationId: "4" } }), /role/);
    });
});
