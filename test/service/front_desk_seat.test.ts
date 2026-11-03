import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message, Type } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { FRONT_DESK_EXTENSION_NAME } from "../../src/desk/desk_model.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const DESK_READ_JOB_DESCRIPTION = "Stand-in front desk read_job.";
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type OfferedTool = { name: string; description: string };
type Booted = {
    daemon: RunningDaemon;
    ctx: ServiceContext;
    seatFor(role: string, place?: "job" | "front_desk"): Seat;
    /** Runs one model turn in the conversation and returns the tools its request offered. */
    offeredTo(conversationId: string): Promise<OfferedTool[]>;
};

// pi-durable sends the tools as changes on system messages; the tools in effect are the fold of them.
function toolsOf(messages: Message[]): OfferedTool[] {
    const inEffect = new Map<string, OfferedTool>();
    for (const message of messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) inEffect.set(tool.name, tool);
        for (const tool of message.toolsRemoved ?? []) inEffect.delete(tool.name);
    }
    return [...inEffect.values()];
}

const standInDesk = () =>
    defineExtension({
        name: FRONT_DESK_EXTENSION_NAME,
        tools: [
            defineTool({
                name: "read_job",
                description: DESK_READ_JOB_DESCRIPTION,
                parameters: Type.Object({}),
                async execute() {
                    return { output: [{ type: "text", text: "{}" }] };
                },
            }),
        ],
    });

async function boot(): Promise<Booted> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let lastOffered: OfferedTool[] = [];
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        lastOffered = toolsOf(context.messages);
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger });
    let captured: ServiceContext | undefined;
    const desk: DaemonComponent = {
        name: "stand-in-desk",
        optInExtensions: [standInDesk()],
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
        components: [agents.component, jobs.component, desk],
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
        if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const ctx = captured as ServiceContext;
    let turn = 0;
    return {
        daemon,
        ctx,
        seatFor: (role, place = "job") => jobs.options.agents.runtime().catalog.seatFor(role, {}, place),
        async offeredTo(conversationId) {
            turn += 1;
            const requestId = `req-${conversationId}-${turn}`;
            const { submissionId } = await submitInput(ctx.host, conversationId, {
                content: "hello",
                requestId,
                busyMode: "followUp",
            });
            await waitForSubmission(ctx.host, submissionId, WAIT_MS);
            return lastOffered;
        },
    };
}

async function seatFrontDesk(booted: Booted, role: string): Promise<string> {
    const { conversationId } = await createSeatedConversation(booted.ctx.host, {
        scope: "front-desk-seat-test",
        key: "front-desk",
        job: { jobId: null, isLead: false, origin: { kind: "front_desk" }, depth: 0 },
        seat: booted.seatFor(role, "front_desk"),
        actor: { kind: "daemon" },
    });
    return conversationId;
}

describe("the front desk's extension selection", () => {
    it("offers the front desk the intern.desk tools and no coordination or job tool", async () => {
        const booted = await boot();
        const id = await seatFrontDesk(booted, "desk");

        const offered = await booted.offeredTo(id);

        const names = offered.map((tool) => tool.name);
        assert.deepEqual(
            offered.filter((tool) => tool.name === "read_job").map((tool) => tool.description),
            [DESK_READ_JOB_DESCRIPTION],
        );
        for (const coordination of ["handoff", "invoke", "steer", "create_job", "update_job"]) {
            assert.ok(!names.includes(coordination), `${coordination} must not be offered`);
        }
    });

    it("offers a conversation of a job none of the opt-in extension's tools", async () => {
        const booted = await boot();
        const job = (await booted.daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as {
            leadConversation: string;
        };

        const offered = await booted.offeredTo(job.leadConversation);

        const readJobs = offered.filter((tool) => tool.name === "read_job");
        assert.equal(readJobs.length, 1);
        assert.notEqual(readJobs[0]?.description, DESK_READ_JOB_DESCRIPTION);
    });

    it("offers gp's tools and the front-desk tools when gp is seated in the front desk's conversation", async () => {
        const booted = await boot();
        const id = await seatFrontDesk(booted, DEFAULT_LEAD_ROLE);

        await booted.daemon.catalogue.invoke("conversations.seat", { conversationId: id, role: "gp" }, webCaller);
        const offered = await booted.offeredTo(id);

        const names = offered.map((tool) => tool.name);
        for (const tool of ["read", "write", "edit", "bash", "read_job"]) {
            assert.ok(names.includes(tool), `${tool} must be offered`);
        }
        assert.equal(offered.find((tool) => tool.name === "read_job")?.description, DESK_READ_JOB_DESCRIPTION);
        for (const coordination of ["handoff", "invoke", "steer"]) {
            assert.ok(!names.includes(coordination), `${coordination} must not be offered`);
        }
    });
});
