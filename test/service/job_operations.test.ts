import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createSeatedConversation, readConversationMeta, SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SETTLE_MS = 400;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "cli" } };
const requestOrigin = { kind: "request", wayIn: "cli" } as const;

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Started = {
    ctx: ServiceContext;
    provider: string;
    startLead(input: Record<string, unknown>, as?: Caller): Promise<{ conversationId: string; created: boolean }>;
    folder(name: string): Promise<string>;
    seatConversation(slot?: { scope: string; key: string }): Promise<string>;
    answerCount(conversationId: string): Promise<number>;
    userInputs(conversationId: string): Promise<string[]>;
    seatRecords(conversationId: string): Promise<unknown[]>;
    conversationCount(): Promise<number>;
};

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({
        models: [
            { id: "model-one", reasoning: true },
            { id: "model-two", reasoning: true },
        ],
    });
    const answer = async () => {
        fake.appendResponses([answer]);
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
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
    return {
        ctx,
        provider,
        startLead: (input, as = caller) => daemon.catalogue.invoke("jobs.startLead", input, as) as never,
        async folder(name) {
            const path = join(env.root, name);
            await mkdir(path);
            await chmod(path, 0o700);
            await agents.runtime().workspaces.register(path);
            return path;
        },
        async seatConversation(slot = { scope: "test", key: "existing" }) {
            const { conversationId } = await createSeatedConversation(ctx.host, {
                ...slot,
                job: { jobId: "other-job", isLead: true, origin: requestOrigin, depth: 0 },
                seat: agents.runtime().catalog.seatFor("gp"),
                actor: caller.actor as never,
            });
            return conversationId;
        },
        async userInputs(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === "pi.user").map((entry) => JSON.stringify(entry.data));
        },
        async answerCount(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === "pi.assistant").length;
        },
        async seatRecords(conversationId) {
            const page = await ctx.host.readEntries(conversationId, { limit: 100 });
            return page.entries.filter((entry) => entry.kind === SEAT_RECORD_KIND).map((entry) => entry.data);
        },
        async conversationCount() {
            return (await ctx.host.listConversations()).length;
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

async function waitForInputs(started: Started, conversationId: string, count: number): Promise<string[]> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const inputs = await started.userInputs(conversationId);
        if (inputs.length >= count || Date.now() > deadline) return inputs;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

// Returns the answer count once it reaches `count` or the wait ends.
async function waitForAnswers(started: Started, conversationId: string, count: number, waitMs = WAIT_MS) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const answers = await started.answerCount(conversationId);
        if (answers >= count || Date.now() > deadline) return answers;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

describe("jobs.startLead", () => {
    it("seats the lead conversation as bob with its defaults, its job links and the first input", async () => {
        const started = await start();

        const result = await started.startLead({
            jobId: "job-1",
            firstInput: "plan the release",
            origin: requestOrigin,
        });

        assert.equal(result.created, true);
        const meta = await readConversationMeta(started.ctx.host, result.conversationId);
        assert.equal(meta?.seat.role, "bob");
        assert.equal(meta?.jobId, "job-1");
        assert.equal(meta?.isLead, true);
        assert.equal(meta?.depth, 0);
        assert.deepEqual(meta?.origin, requestOrigin);
        const inputs = await waitForInputs(started, result.conversationId, 1);
        assert.equal(inputs.length, 1);
        assert.match(inputs[0] ?? "", /plan the release/);
    });

    it("seats the named role with the model, thinking level and workspace a request names", async () => {
        const started = await start();
        const workspace = await started.folder("elsewhere");

        const { conversationId } = await started.startLead({
            jobId: "job-2",
            firstInput: "go",
            origin: requestOrigin,
            role: "gp",
            model: `${started.provider}/model-two`,
            thinkingLevel: "low",
            workspace,
        });

        const meta = await readConversationMeta(started.ctx.host, conversationId);
        assert.equal(meta?.seat.role, "gp");
        assert.equal(meta?.seat.model, `${started.provider}/model-two`);
        assert.equal(meta?.seat.thinkingLevel, "low");
        assert.equal(meta?.seat.workspace, workspace);
    });

    it("records the origin of each job source kind and the job source as the seat actor", async () => {
        const started = await start();
        const existing = await started.seatConversation();
        const origins = [
            { kind: "request", wayIn: "telegram" },
            { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" },
            { kind: "trigger", trigger: "ci", event: "build-failed" },
            { kind: "follow_up", conversationId: existing },
        ];
        for (const [index, origin] of origins.entries()) {
            const { conversationId } = await started.startLead({ jobId: `origin-${index}`, firstInput: "go", origin });
            const meta = await readConversationMeta(started.ctx.host, conversationId);
            assert.deepEqual(meta?.origin, origin);
        }

        const source: Caller = { actor: { kind: "job_source", source: "schedule" } };
        const { conversationId } = await started.startLead(
            { jobId: "by-source", firstInput: "go", origin: origins[1] },
            source,
        );
        const [record] = (await started.seatRecords(conversationId)) as { actor: unknown }[];
        assert.deepEqual(record?.actor, { kind: "job_source", source: "schedule" });
    });

    it("returns the original conversation on a repeat and submits the first input once", async () => {
        const started = await start();
        const first = await started.startLead({ jobId: "job-3", firstInput: "only once", origin: requestOrigin });
        await waitForInputs(started, first.conversationId, 1);
        const before = await started.conversationCount();

        await waitForAnswers(started, first.conversationId, 1);

        const repeat = await started.startLead({ jobId: "job-3", firstInput: "only once", origin: requestOrigin });
        // A second submission would start another turn; give it time to show before counting.
        const duplicateAnswers = await waitForAnswers(started, first.conversationId, 2, SETTLE_MS);

        assert.deepEqual(repeat, { conversationId: first.conversationId, created: false });
        assert.equal(await started.conversationCount(), before);
        assert.equal(duplicateAnswers, 1);
        assert.equal((await started.userInputs(first.conversationId)).length, 1);
    });

    it("submits the first input to a conversation created before a crash, once", async () => {
        const started = await start();
        const existing = await started.seatConversation({ scope: "jobs.startLead", key: "job-9" });

        await started.startLead({ jobId: "job-9", firstInput: "repair me", origin: requestOrigin });
        await started.startLead({ jobId: "job-9", firstInput: "repair me", origin: requestOrigin });

        const inputs = await waitForInputs(started, existing, 1);
        assert.equal(inputs.length, 1);
        assert.match(inputs[0] ?? "", /repair me/);
    });

    it("returns the conversation that holds the job's key in the jobs.startLead scope", async () => {
        const started = await start();
        const existing = await started.seatConversation({ scope: "jobs.startLead", key: "job-8" });

        const result = await started.startLead({ jobId: "job-8", firstInput: "go", origin: requestOrigin });

        assert.deepEqual(result, { conversationId: existing, created: false });
    });

    it("refuses an unknown role and creates nothing", async () => {
        const started = await start();
        const before = await started.conversationCount();

        const code = await refusalCode(
            started.startLead({ jobId: "job-4", firstInput: "go", origin: requestOrigin, role: "nobody" }),
        );

        assert.equal(code, "not_found");
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses an override that cannot be resolved and creates nothing", async () => {
        const started = await start();
        const before = await started.conversationCount();

        const code = await refusalCode(
            started.startLead({ jobId: "job-5", firstInput: "go", origin: requestOrigin, model: "nope/none" }),
        );

        assert.ok(code === "not_found" || code === "invalid_input");
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses an override named by a source other than a request and creates nothing", async () => {
        const started = await start();
        const before = await started.conversationCount();

        const code = await refusalCode(
            started.startLead({
                jobId: "job-6",
                firstInput: "go",
                origin: { kind: "schedule", entry: "nightly", fireTime: "2026-10-31T02:00:00Z" },
                thinkingLevel: "low",
            }),
        );

        assert.equal(code, "invalid_input");
        assert.equal(await started.conversationCount(), before);
    });

    it("refuses a follow-up origin that names no existing conversation", async () => {
        const started = await start();
        const before = await started.conversationCount();

        const code = await refusalCode(
            started.startLead({
                jobId: "job-7",
                firstInput: "go",
                origin: { kind: "follow_up", conversationId: "999999" },
            }),
        );

        assert.equal(code, "not_found");
        assert.equal(await started.conversationCount(), before);
    });
});
