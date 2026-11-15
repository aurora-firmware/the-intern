/**
 * The enabled set of one agent (S-008 REQ-006; ADR-001 decision 4): `setEnabledSkill` changes the set and appends the
 * `intern.skills` entry in one commit, outside the model's context, and a closed conversation is refused.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput } from "../../src/host/conversation_control.ts";
import { toConversationId } from "../../src/host/conversation_id.ts";
import { type HostEntry, internalHarness } from "../../src/host/harness_host.ts";
import { abortJobConversations } from "../../src/host/invocation.ts";
import { ConversationClosedError } from "../../src/host/job_section.ts";
import {
    conversationMetaDoc,
    createSeatedConversation,
    readConversationMeta,
    type SeatActor,
} from "../../src/host/seating.ts";
import { SKILLS_RECORD_KIND, setEnabledSkill } from "../../src/host/skill_set.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const DEFAULTS = ["alpha", "beta"];
const defaultsOf = () => [...DEFAULTS];
const NEW_SKILL = "gamma-skill";
const teamMember: SeatActor = { kind: "team_member", wayIn: "cli" };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const requests: Message[][] = [];
    fake.setResponses([
        (context: { messages: Message[] }) => {
            requests.push(context.messages);
            return fauxAssistantMessage("ok");
        },
    ]);
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
    const host = (captured as ServiceContext).host;
    let count = 0;
    const seatConversation = async (jobId: string | null) => {
        count += 1;
        const place = jobId === null ? "front_desk" : "job";
        const origin =
            jobId === null ? ({ kind: "front_desk" } as const) : ({ kind: "request", wayIn: "cli" } as const);
        const { conversationId } = await createSeatedConversation(host, {
            scope: "closed-seat",
            key: `conversation-${count}`,
            job: { jobId, isLead: jobId !== null, origin, depth: 0 },
            seat: agents.runtime().catalog.seatFor("gp", {}, place),
            actor: teamMember,
        });
        return conversationId;
    };
    const entries = async (id: string): Promise<HostEntry[]> => (await host.readEntries(id, { limit: 500 })).entries;
    const skillEntries = async (id: string) => (await entries(id)).filter((entry) => entry.kind === SKILLS_RECORD_KIND);
    return { host, seatConversation, entries, skillEntries, requests };
}

const enabledOf = async (started: Started, id: string) => (await readConversationMeta(started.host, id))?.enabledSkills;

type Started = Awaited<ReturnType<typeof start>>;

describe("setEnabledSkill", () => {
    it("changes the set and appends one intern.skills entry with the actor, the skill and the new set", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        const initial = (await enabledOf(started, id)) ?? [];

        const set = await setEnabledSkill(
            started.host,
            id,
            { name: NEW_SKILL, enable: true, actor: teamMember },
            defaultsOf,
        );

        assert.deepEqual(set, [...initial, NEW_SKILL]);
        assert.deepEqual(await enabledOf(started, id), set);
        const entries = await started.skillEntries(id);
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0]?.data, {
            actor: teamMember,
            skill: NEW_SKILL,
            change: "enabled",
            enabledSkills: set,
        });
    });

    it("disables a name in the set and records it", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        await setEnabledSkill(started.host, id, { name: NEW_SKILL, enable: true, actor: teamMember }, defaultsOf);

        const set = await setEnabledSkill(
            started.host,
            id,
            { name: NEW_SKILL, enable: false, actor: teamMember },
            defaultsOf,
        );

        assert.equal(set.includes(NEW_SKILL), false);
        const entries = await started.skillEntries(id);
        assert.equal(entries.length, 2);
        assert.deepEqual(entries[1]?.data, {
            actor: teamMember,
            skill: NEW_SKILL,
            change: "disabled",
            enabledSkills: set,
        });
    });

    it("commits nothing when the set already holds the name", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        await setEnabledSkill(started.host, id, { name: NEW_SKILL, enable: true, actor: teamMember }, defaultsOf);
        const before = (await started.entries(id)).length;

        const set = await setEnabledSkill(
            started.host,
            id,
            { name: NEW_SKILL, enable: true, actor: teamMember },
            defaultsOf,
        );

        assert.deepEqual(set, await enabledOf(started, id));
        assert.equal((await started.entries(id)).length, before);
    });

    it("commits nothing when the name to disable is not in the set", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        const before = (await started.entries(id)).length;

        const set = await setEnabledSkill(
            started.host,
            id,
            { name: NEW_SKILL, enable: false, actor: teamMember },
            defaultsOf,
        );

        assert.deepEqual(set, await enabledOf(started, id));
        assert.equal((await started.entries(id)).length, before);
    });

    it("reads a document with no enabled set as the role's defaults", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        await internalHarness(started.host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, toConversationId(id));
            delete meta.enabledSkills;
        }, BACKGROUND_CONTEXT);

        const set = await setEnabledSkill(
            started.host,
            id,
            { name: NEW_SKILL, enable: true, actor: teamMember },
            defaultsOf,
        );

        assert.deepEqual(set, [...DEFAULTS, NEW_SKILL]);
        assert.deepEqual(await enabledOf(started, id), set);
    });

    it("refuses a closed conversation with ConversationClosedError and commits nothing", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        const setBefore = await enabledOf(started, id);
        await abortJobConversations(started.host, "job-1");
        const before = (await started.entries(id)).length;

        await assert.rejects(
            setEnabledSkill(started.host, id, { name: NEW_SKILL, enable: true, actor: teamMember }, defaultsOf),
            ConversationClosedError,
        );

        assert.equal((await started.entries(id)).length, before);
        assert.deepEqual(await enabledOf(started, id), setBefore);
    });

    it("sends no message of the intern.skills entry to the model", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        await setEnabledSkill(started.host, id, { name: NEW_SKILL, enable: true, actor: teamMember }, defaultsOf);

        await submitInput(started.host, id, { content: "hello", requestId: "r1", busyMode: "followUp" });
        const deadline = Date.now() + WAIT_MS;
        while (started.requests.length === 0) {
            if (Date.now() > deadline) throw new Error("the model was not asked");
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }

        const texts = JSON.stringify(started.requests[0]);
        assert.match(texts, /hello/);
        assert.doesNotMatch(texts, new RegExp(NEW_SKILL));
    });
});
