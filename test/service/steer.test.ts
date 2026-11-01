import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type AssistantMessage,
    type FauxProviderRegistration,
    fauxAssistantMessage,
    fauxToolCall,
    type JsonObject,
    type Message,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import { STEER_RECORD_KIND, steerConversation } from "../../src/host/steering.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const UNKNOWN_ID = "9999";
const quietLogger = createLogger({ stream: { write: () => true } });
const teamMember: Caller = { actor: { kind: "team_member", wayIn: "cli" } };
const requestOrigin = { kind: "request", wayIn: "cli" } as const;
const CLI_ACTOR: SeatActor = { kind: "team_member", wayIn: "cli" };

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

type ModelCall = { first: string; nth: number; messages: Message[]; results: Message[] };
type Script = (call: ModelCall) => Promise<AssistantMessage | undefined> | AssistantMessage | undefined;

const usersOf = (messages: Message[]): string[] => messages.filter((m) => m.role === "user").map(textOf);

function toolNamesOf(messages: Message[]): string[] {
    const inEffect = new Set<string>();
    for (const message of messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) inEffect.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) inEffect.delete(tool.name);
    }
    return [...inEffect];
}

async function start(script: Script) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const calls: ModelCall[] = [];
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        const first = usersOf(context.messages)[0] ?? "";
        const nth = calls.filter((call) => call.first === first).length;
        const call: ModelCall = {
            first,
            nth,
            messages: context.messages,
            results: context.messages.filter((m) => m.role === "toolResult"),
        };
        calls.push(call);
        return (await script(call)) ?? fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
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
        calls,
        callsOf: (first: string) => calls.filter((call) => call.first === first),
        startLead: async (firstInput: string, jobId: string, role?: string) =>
            (
                (await daemon.catalogue.invoke(
                    "jobs.startLead",
                    { jobId, firstInput, origin: requestOrigin, ...(role !== undefined && { role }) },
                    teamMember,
                )) as { conversationId: string }
            ).conversationId,
        submit: (conversationId: string, content: string, requestId: string, busyMode?: string) =>
            daemon.catalogue.invoke(
                "conversations.submit",
                { conversationId, content, requestId, ...(busyMode !== undefined && { busyMode }) },
                teamMember,
            ),
    };
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function gate() {
    let release = (): void => {};
    const opened = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { opened, release };
}

const steerCall = (conversationId: string, message: string, mode: "steer" | "followUp"): AssistantMessage =>
    fauxAssistantMessage([fauxToolCall("steer", { conversationId, message, mode } as JsonObject)], {
        stopReason: "toolUse",
    });

const noopCall = (): AssistantMessage => fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" });

type SteerEntry = { actor: SeatActor; mode?: string };

async function steerEntriesOf(ctx: ServiceContext, conversationId: string): Promise<SteerEntry[]> {
    const conversation = await internalHarness(ctx.host).conversation(
        Number(conversationId) as ConversationId,
        BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    return (page?.items ?? [])
        .filter((entry) => entry.kind === STEER_RECORD_KIND)
        .map((entry) => {
            const { actor, mode } = entry.data as SteerEntry;
            return { actor, mode };
        });
}

// The transcript in order, as the entry kind and the text a message entry carries (empty for other entries).
async function transcriptOf(ctx: ServiceContext, conversationId: string): Promise<{ kind: string; text: string }[]> {
    const conversation = await internalHarness(ctx.host).conversation(
        Number(conversationId) as ConversationId,
        BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    return (page?.items ?? []).map((entry) => ({ kind: entry.kind, text: textOf(entry.model?.[0]) }));
}

// The steered message is placed as the intern.steer entry itself, so the record and the message are one commit and
// no pi.user entry repeats it.
async function assertPlacedAsSteerEntry(ctx: ServiceContext, conversationId: string, message: string) {
    const transcript = await transcriptOf(ctx, conversationId);
    const carriers = transcript.filter((entry) => entry.text === message);
    assert.deepEqual(
        carriers.map((entry) => entry.kind),
        [STEER_RECORD_KIND],
        "the message is placed once, as the steer entry",
    );
    const placed = (await rawSteerDataOf(ctx, conversationId)).filter((data) => data.content === message);
    assert.equal(placed.length, 1, "the steer entry's data shows the message text");
}

async function rawSteerDataOf(ctx: ServiceContext, conversationId: string): Promise<{ content?: string }[]> {
    const conversation = await internalHarness(ctx.host).conversation(
        Number(conversationId) as ConversationId,
        BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    return (page?.items ?? []).filter((entry) => entry.kind === STEER_RECORD_KIND).map((e) => e.data as never);
}

const isBusy = async (ctx: ServiceContext, id: string) => (await ctx.host.conversationInfo(id))?.busy !== false;

describe("the steer tool and steering a conversation", () => {
    it("delivers a steer after the current tool round and records the agent that steered", async () => {
        const targetGate = gate();
        const ids: { target?: string } = {};
        const started = await start(async (call) => {
            if (call.first === "target work") {
                if (call.nth === 0) {
                    await targetGate.opened;
                    return noopCall();
                }
                return undefined;
            }
            if (call.first === "steerer work" && call.nth === 0) {
                return steerCall(ids.target as string, "change course", "steer");
            }
            return undefined;
        });
        ids.target = await started.startLead("target work", "job-target");
        await waitFor(() => started.callsOf("target work").length === 1, "the target's first request");

        const steererId = await started.startLead("steerer work", "job-steerer", "gp");
        await waitFor(() => started.callsOf("steerer work").length === 2, "the steerer to get the tool result");
        targetGate.release();
        await waitFor(() => started.callsOf("target work").length >= 2, "the target's request after the tool round");

        const afterRound = started.callsOf("target work")[1] as ModelCall;
        assert.ok(
            usersOf(afterRound.messages).includes("change course"),
            "the steer is in the context after the round",
        );
        assert.deepEqual(await steerEntriesOf(started.ctx, ids.target), [
            { actor: { kind: "agent", conversationId: steererId, role: "gp" }, mode: "steer" },
        ]);
        await assertPlacedAsSteerEntry(started.ctx, ids.target, "change course");
    });

    it("delivers a follow-up only after the run ends", async () => {
        const targetGate = gate();
        const ids: { target?: string } = {};
        const started = await start(async (call) => {
            if (call.first === "target work") {
                if (call.nth === 0) {
                    await targetGate.opened;
                    return noopCall();
                }
                return undefined;
            }
            if (call.first === "steerer work" && call.nth === 0) {
                return steerCall(ids.target as string, "afterwards", "followUp");
            }
            return undefined;
        });
        ids.target = await started.startLead("target work", "job-target");
        await waitFor(() => started.callsOf("target work").length === 1, "the target's first request");
        await started.startLead("steerer work", "job-steerer", "gp");
        await waitFor(() => started.callsOf("steerer work").length === 2, "the steerer to get the tool result");

        targetGate.release();

        await waitFor(() => started.callsOf("target work").length >= 3, "the target's request after the run");
        const [, afterRound, afterRun] = started.callsOf("target work") as ModelCall[];
        assert.ok(!usersOf((afterRound as ModelCall).messages).includes("afterwards"));
        assert.ok(usersOf((afterRun as ModelCall).messages).includes("afterwards"));
    });

    it("offers steer, handoff and invoke to an agent of a role that lists none of them", async () => {
        const started = await start(() => undefined);

        const steererId = await started.startLead("steerer work", "job-steerer", "gp");

        await waitFor(() => started.callsOf("steerer work").length === 1, "the steerer's request");
        const meta = await readConversationMeta(started.ctx.host, steererId);
        assert.deepEqual(meta?.seat.tools.filter((tool) => ["handoff", "invoke", "steer"].includes(tool)).sort(), [
            "handoff",
            "invoke",
            "steer",
        ]);
        const offered = toolNamesOf((started.callsOf("steerer work")[0] as ModelCall).messages);
        for (const name of ["handoff", "invoke", "steer"]) assert.ok(offered.includes(name), `${name} is offered`);
    });

    it("returns an error result for an unknown conversation and continues the run", async () => {
        const started = await start((call) =>
            call.first === "steerer work" && call.nth === 0 ? steerCall(UNKNOWN_ID, "hello", "steer") : undefined,
        );

        await started.startLead("steerer work", "job-steerer", "gp");

        await waitFor(() => started.callsOf("steerer work").length === 2, "the steerer to continue");
        const result = (started.callsOf("steerer work")[1] as ModelCall).results[0];
        assert.ok(result?.role === "toolResult" && result.isError, "the tool result is an error");
        assert.match(textOf(result), new RegExp(UNKNOWN_ID));
    });

    it("records the team member and their way in when steering an idle conversation", async () => {
        const started = await start(() => undefined);
        const targetId = await started.startLead("target work", "job-target");
        await waitFor(
            async () => started.callsOf("target work").length === 1 && !(await isBusy(started.ctx, targetId)),
            "the run to end",
        );

        await started.submit(targetId, "one more thing", "more-1");

        await waitFor(() => started.callsOf("target work").length === 2, "the run for the new input");
        assert.ok(usersOf((started.callsOf("target work")[1] as ModelCall).messages).includes("one more thing"));
        assert.deepEqual(await steerEntriesOf(started.ctx, targetId), [{ actor: CLI_ACTOR, mode: "followUp" }]);
        await assertPlacedAsSteerEntry(started.ctx, targetId, "one more thing");
    });

    describe("a parked conversation", () => {
        const parkedInvoke = fauxAssistantMessage(
            [
                fauxToolCall("invoke", {
                    agents: [{ role: "gp", contextMode: "clean", jobPrompt: "job A" }],
                    // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
                    then: "parked",
                } as JsonObject),
            ],
            { stopReason: "toolUse" },
        );

        async function startParkedLead(extra: Script = () => undefined) {
            const invokedGate = gate();
            const ids: { lead?: string } = {};
            const started = await start(async (call) => {
                if (call.first === "lead work") return call.nth === 0 ? parkedInvoke : undefined;
                if (call.first === "job A") {
                    await invokedGate.opened;
                    return fauxAssistantMessage("report of job A");
                }
                if (call.first === "steerer work" && call.nth === 0) {
                    return steerCall(ids.lead as string, "from the agent", "followUp");
                }
                return extra(call);
            });
            ids.lead = await started.startLead("lead work", "job-lead");
            await waitFor(() => started.callsOf("job A").length === 1, "the invoked agent to start");
            await waitFor(
                async () => (await readConversationMeta(started.ctx.host, ids.lead as string))?.parked !== null,
                "the lead to park",
            );
            return { started, leadId: ids.lead, release: invokedGate.release };
        }

        it("holds messages from a team member and an agent without a run and delivers them when it continues", async () => {
            const { started, leadId, release } = await startParkedLead();

            await started.submit(leadId, "from the team member", "member-1", "steer");
            await started.startLead("steerer work", "job-steerer", "gp");
            await waitFor(() => started.callsOf("steerer work").length === 2, "the steerer to get the tool result");

            assert.equal(started.callsOf("lead work").length, 1, "no run started for the held messages");
            const held = (await readConversationMeta(started.ctx.host, leadId))?.held ?? [];
            assert.deepEqual(
                held.map((message) => message.content),
                ["from the team member", "from the agent"],
            );
            const recorded = await steerEntriesOf(started.ctx, leadId);
            assert.deepEqual(
                recorded.map((entry) => entry.actor.kind),
                ["team_member", "agent"],
            );
            assert.deepEqual(recorded[0]?.actor, CLI_ACTOR);

            release();

            await waitFor(
                () => started.callsOf("lead work").some((call) => usersOf(call.messages).includes("report of job A")),
                "the lead to continue with the report",
            );
            const users = usersOf((started.callsOf("lead work").at(-1) as ModelCall).messages);
            for (const expected of ["from the team member", "from the agent", "report of job A"]) {
                assert.ok(users.includes(expected), `the lead's context holds "${expected}"`);
            }
            assert.deepEqual((await readConversationMeta(started.ctx.host, leadId))?.held, []);
        });

        it("holds a message once when the same request is steered twice", async () => {
            const { started, leadId, release } = await startParkedLead();
            const message = { content: "once", mode: "steer", actor: CLI_ACTOR, requestId: "dup-1" } as const;

            const first = await steerConversation(started.ctx.host, leadId, message);
            const second = await steerConversation(started.ctx.host, leadId, message);

            assert.deepEqual([first, second], [{ held: true }, { held: true }]);
            assert.equal((await readConversationMeta(started.ctx.host, leadId))?.held.length, 1);
            assert.equal((await steerEntriesOf(started.ctx, leadId)).length, 1);
            release();
        });

        it("holds a reject input like any other message and delivers it when it continues", async () => {
            const { started, leadId, release } = await startParkedLead();

            const first = await started.submit(leadId, "rejectable", "reject-1", "reject");
            const second = await started.submit(leadId, "rejectable", "reject-1", "reject");

            assert.deepEqual([first, second], [{ held: true }, { held: true }]);
            assert.equal(started.callsOf("lead work").length, 1, "no run started for the held reject input");
            const held = (await readConversationMeta(started.ctx.host, leadId))?.held ?? [];
            assert.deepEqual(
                held.map((message) => [message.content, message.mode]),
                [["rejectable", "followUp"]],
            );
            assert.deepEqual(await steerEntriesOf(started.ctx, leadId), [{ actor: CLI_ACTOR, mode: "followUp" }]);

            release();

            await waitFor(
                () => started.callsOf("lead work").some((call) => usersOf(call.messages).includes("report of job A")),
                "the lead to continue with the report",
            );
            const users = usersOf((started.callsOf("lead work").at(-1) as ModelCall).messages);
            for (const expected of ["rejectable", "report of job A"]) {
                assert.ok(users.includes(expected), `the lead's context holds "${expected}"`);
            }
            assert.deepEqual((await readConversationMeta(started.ctx.host, leadId))?.held, []);
        });
    });
});
