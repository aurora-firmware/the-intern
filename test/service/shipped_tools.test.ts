import assert from "node:assert/strict";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { createSeatedConversation, type JobLinks, type SeatActor } from "../../src/host/seating.ts";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { COORDINATION_TOOL_NAMES, resolveSeat, SHIPPED_TOOL_NAMES } from "../../src/roles/role_model.ts";
import { SHIPPED_TOOLS_EXTENSION_NAME, shippedToolsExtension } from "../../src/tools/shipped_tools_extension.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const quietLogger = createLogger({ stream: { write: () => true } });
const WAIT_MS = 10_000;
const job: JobLinks = { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 };
const actor: SeatActor = { kind: "team_member", wayIn: "cli" };

type Step = { toolCall: { name: string; arguments: Record<string, unknown> } } | { text: string };
type ModelContext = Parameters<FauxResponseFactory>[0];

const fakes: FauxProviderRegistration[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

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

type ToolResultSeen = { text: string; isError: boolean };

function toolResultsOf(context: ModelContext): ToolResultSeen[] {
    return context.messages.flatMap((message) =>
        message.role === "toolResult"
            ? [
                  {
                      text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
                      isError: message.isError,
                  },
              ]
            : [],
    );
}

// The fake model plays the steps in order, one per request, and records what each request offered and carried.
async function createFixture(steps: Step[]) {
    const env = await createHermeticEnv();
    envs.push(env);
    const offered: string[][] = [];
    const results: ToolResultSeen[][] = [];
    const fake = registerFauxProvider();
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        offered.push(toolNamesOf(context));
        results.push(toolResultsOf(context));
        const step = steps[offered.length - 1] ?? { text: "done" };
        if ("text" in step) return fauxAssistantMessage(step.text);
        return fauxAssistantMessage([fauxToolCall(step.toolCall.name, step.toolCall.arguments as never)], {
            stopReason: "toolUse",
        });
    };
    fake.setResponses([respond]);
    fakes.push(fake);
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation);
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger });
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models,
        harnessSettings: {},
        extensions: [...(agents.component.extensions ?? []), ...(jobs.component.extensions ?? [])],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const workspace = join(env.root, "workspace");
    await mkdir(workspace);
    const seat = (tools: string[]) => ({
        role: "developer",
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace,
        instructions: "Work.",
        tools,
        skills: [],
    });
    const seatConversation = async (tools: string[]) =>
        (await createSeatedConversation(host, { scope: "s", key: "k", job, seat: seat(tools), actor })).conversationId;
    let turn = 0;
    const say = async (conversationId: string) => {
        turn += 1;
        const submission = await submitInput(host, conversationId, {
            content: `turn ${turn}`,
            requestId: `r${turn}`,
            busyMode: "reject",
        });
        return waitForSubmission(host, submission.submissionId, WAIT_MS);
    };
    const jobToolsRegistered = (jobs.component.extensions ?? []).flatMap((extension) =>
        (extension.tools ?? []).map((tool) => tool.name),
    );
    return { offered, results, workspace, seatConversation, say, jobToolsRegistered };
}

describe("the shipped tools extension", () => {
    it("is named intern.tools and brings exactly the shipped tools", () => {
        assert.equal(SHIPPED_TOOLS_EXTENSION_NAME, "intern.tools");
        assert.equal(shippedToolsExtension.name, SHIPPED_TOOLS_EXTENSION_NAME);
        assert.deepEqual(shippedToolsExtension.tools?.map((tool) => tool.name).sort(), [...SHIPPED_TOOL_NAMES].sort());
    });

    it("offers a read-only role read, the coordination tools and the job tools, not write, edit or bash", async () => {
        const { offered, seatConversation, say, jobToolsRegistered } = await createFixture([]);
        const { tools } = resolveSeat(
            { name: "reader", instructions: "Read.", tools: ["read"], skills: [] },
            {
                model: "m",
                workspace: "/w",
            },
        );
        const id = await seatConversation(tools);

        await say(id);

        assert.deepEqual(tools, ["read", ...COORDINATION_TOOL_NAMES, ...JOB_TOOL_NAMES]);
        // The Jobs component registers the job tools it has so far; the lead-only ones follow in a later task.
        assert.ok(jobToolsRegistered.every((name) => (JOB_TOOL_NAMES as readonly string[]).includes(name)));
        assert.deepEqual([...offered[0]].sort(), ["read", ...COORDINATION_TOOL_NAMES, ...jobToolsRegistered].sort());
        for (const absent of ["write", "edit", "bash"]) assert.equal(offered[0].includes(absent), false, absent);
    });

    it("runs bash in the workspace the conversation is seated in", async () => {
        const { results, workspace, seatConversation, say } = await createFixture([
            { toolCall: { name: "bash", arguments: { command: "pwd" } } },
        ]);
        const id = await seatConversation(["bash"]);

        await say(id);

        assert.match(
            results[1].map((result) => result.text).join("\n"),
            new RegExp(`${(await realpath(workspace)).replace(/\//g, "\\/")}\\s*$`),
        );
    });

    it("returns an error result and answers the next input when the workspace folder is removed", async () => {
        const { results, workspace, seatConversation, say } = await createFixture([
            { text: "first" },
            { toolCall: { name: "bash", arguments: { command: "pwd" } } },
            { text: "after the error" },
            { text: "answer to the next input" },
        ]);
        const id = await seatConversation(["bash", "read"]);
        await say(id);
        await rm(workspace, { recursive: true });

        const second = await say(id);
        const third = await say(id);

        assert.equal(second.state, "done");
        assert.equal(third.state, "done");
        assert.equal(results[2].length, 1, "the model saw one tool result");
        assert.equal(results[2][0].isError, true);
        assert.match(results[2][0].text, new RegExp(workspace.replace(/[/.]/g, "\\$&")));
    });
});
