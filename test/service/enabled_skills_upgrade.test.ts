/**
 * The upgrade write for conversations from before S-008 (ADR-001 decision 4; architecture, Startup step 7):
 * `upgradeEnabledSkills` gives each document without `enabledSkills` its role's default skill names and the `skill`
 * tool, once, and records `enabled-skills` in `intern.upgrades`.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { AgentDoc, type ConversationId, configure } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { toConversationId } from "../../src/host/conversation_id.ts";
import { type HarnessHost, internalHarness } from "../../src/host/harness_host.ts";
import { conversationMetaDoc, createSeatedConversation, readConversationMeta } from "../../src/host/seating.ts";
import { upgradeEnabledSkills, upgradesDocument } from "../../src/host/skill_set.ts";
import { SKILL_TOOL_NAME } from "../../src/roles/role_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const context = BACKGROUND_CONTEXT;
const quietLogger = createLogger({ stream: { write: () => true } });
const UPGRADE_NAME = "enabled-skills";
const GONE_ROLE = "vanished";
const DEFAULTS = ["alpha", "beta"];

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

async function newEnv(): Promise<{ env: HermeticEnv; fake: FauxProviderRegistration }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    fake.setResponses([() => fauxAssistantMessage("ok")]);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: "model-one" }),
    );
    return { env, fake };
}

async function boot(env: HermeticEnv, fake: FauxProviderRegistration) {
    const agents = await createAgentsComponent({ logger: quietLogger });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const provider = fake.getModel().provider;
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
    return { agents, daemon, host: (captured as ServiceContext).host };
}

type Booted = Awaited<ReturnType<typeof boot>>;

// Writes the document and the agent as S-007's version did: no `enabledSkills`, tools without `skill`.
async function writeAsBeforeS008(host: HarnessHost, conversationId: string): Promise<void> {
    const id = toConversationId(conversationId);
    await internalHarness(host).commit(async (tx) => {
        const meta = await tx.doc(conversationMetaDoc, id);
        delete meta.enabledSkills;
        meta.seat.tools = meta.seat.tools.filter((name) => name !== SKILL_TOOL_NAME);
        await configure(tx, id, { tools: meta.seat.tools.map((name) => ({ name }) as never) });
    }, context);
}

async function seatOlder(booted: Booted, role = "gp"): Promise<string> {
    const { agents, host } = booted;
    const base = agents.runtime().catalog.seatFor("gp", {}, "job");
    const { conversationId } = await createSeatedConversation(host, {
        scope: "upgrade",
        key: `${role}-${Math.random()}`,
        job: { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
        seat: { ...base, role },
        actor: { kind: "team_member", wayIn: "cli" },
    });
    await writeAsBeforeS008(host, conversationId);
    return conversationId;
}

async function resetUpgradeRecord(host: HarnessHost): Promise<void> {
    await internalHarness(host).commit(async (tx) => {
        (await tx.doc(upgradesDocument)).done = [];
    }, context);
}

const doneOf = async (host: HarnessHost) => (await internalHarness(host).snapshot(upgradesDocument, context))?.done;
const agentToolsOf = async (host: HarnessHost, id: string) =>
    (await internalHarness(host).snapshot(AgentDoc, Number(id) as ConversationId, context))?.tools;
const metaOf = async (host: HarnessHost, id: string) => await readConversationMeta(host, id);

describe("upgradeEnabledSkills", () => {
    it("gives an older conversation its role's defaults and the skill tool in its seat and its agent", async () => {
        const { env, fake } = await newEnv();
        const booted = await boot(env, fake);
        const id = await seatOlder(booted);
        await resetUpgradeRecord(booted.host);
        const defaults = booted.agents.runtime().catalog.get("gp")?.skills ?? [];

        await upgradeEnabledSkills(booted.host, () => defaults);

        const meta = await metaOf(booted.host, id);
        assert.deepEqual(meta?.enabledSkills, defaults);
        assert.ok(meta?.seat.tools.includes(SKILL_TOOL_NAME));
        assert.ok(((await agentToolsOf(booted.host, id)) as string[]).includes(SKILL_TOOL_NAME));
    });

    it("gives a conversation whose role is gone an empty set", async () => {
        const { env, fake } = await newEnv();
        const booted = await boot(env, fake);
        const id = await seatOlder(booted, GONE_ROLE);
        await resetUpgradeRecord(booted.host);

        await upgradeEnabledSkills(booted.host, (role) => (role === GONE_ROLE ? [] : DEFAULTS));

        const meta = await metaOf(booted.host, id);
        assert.deepEqual(meta?.enabledSkills, []);
        assert.ok(meta?.seat.tools.includes(SKILL_TOOL_NAME));
    });

    it("records enabled-skills and writes nothing on a later call", async () => {
        const { env, fake } = await newEnv();
        const booted = await boot(env, fake);
        await seatOlder(booted);
        await resetUpgradeRecord(booted.host);
        await upgradeEnabledSkills(booted.host, () => DEFAULTS);
        assert.ok((await doneOf(booted.host))?.includes(UPGRADE_NAME));
        const later = await seatOlder(booted);

        await upgradeEnabledSkills(booted.host, () => DEFAULTS);

        assert.equal((await metaOf(booted.host, later))?.enabledSkills, undefined);
    });

    it("finishes for the documents still without the field after a failed run, leaving the finished ones alone", async () => {
        const { env, fake } = await newEnv();
        const booted = await boot(env, fake);
        const first = await seatOlder(booted);
        const second = await seatOlder(booted, "other");
        await resetUpgradeRecord(booted.host);
        await assert.rejects(
            upgradeEnabledSkills(booted.host, (role) => {
                if (role === "other") throw new Error("stop here");
                return DEFAULTS;
            }),
            /stop here/,
        );
        assert.equal(await doneOf(booted.host).then((done) => done?.includes(UPGRADE_NAME)), false);

        await upgradeEnabledSkills(booted.host, () => ["changed"]);

        assert.deepEqual((await metaOf(booted.host, first))?.enabledSkills, DEFAULTS);
        assert.deepEqual((await metaOf(booted.host, second))?.enabledSkills, ["changed"]);
        assert.ok((await doneOf(booted.host))?.includes(UPGRADE_NAME));
    });
});

describe("the daemon start", () => {
    it("upgrades older conversations before it resumes, and a later start writes nothing", async () => {
        const { env, fake } = await newEnv();
        const first = await boot(env, fake);
        const id = await seatOlder(first);
        const gone = await seatOlder(first, GONE_ROLE);
        await resetUpgradeRecord(first.host);
        const defaults = first.agents.runtime().catalog.get("gp")?.skills ?? [];
        await first.daemon.stop();

        const second = await boot(env, fake);

        const meta = await metaOf(second.host, id);
        assert.deepEqual(meta?.enabledSkills, defaults);
        assert.ok(meta?.seat.tools.includes(SKILL_TOOL_NAME));
        assert.ok(((await agentToolsOf(second.host, id)) as string[]).includes(SKILL_TOOL_NAME));
        assert.deepEqual((await metaOf(second.host, gone))?.enabledSkills, []);
        assert.ok((await doneOf(second.host))?.includes(UPGRADE_NAME));
        await second.daemon.stop();

        const regressed = await boot(env, fake);
        await writeAsBeforeS008(regressed.host, id);
        await regressed.daemon.stop();
        const third = await boot(env, fake);
        assert.equal((await metaOf(third.host, id))?.enabledSkills, undefined);
    });
});
