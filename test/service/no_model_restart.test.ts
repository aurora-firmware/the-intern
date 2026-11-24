/**
 * Conversations that wait for a model across a restart (ADR-014 decision 7; S-001 REQ-027, AC-027.4; S-002 REQ-002
 * step 7): work that waits survives a stop and a kill with one notice, a crash between pi-durable's `no_model` commit
 * and the commit of the fact is repaired at the next start, and a folder that names the default model by then seats
 * the waiting conversations before work resumes. The first group runs a daemon process on the fake model; the repair
 * test runs the daemon in this process, with a storage that refuses the commit of the fact.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Storage } from "../../src/host/harness_host.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { NOTICE_KIND } from "../../src/host/model_wait.ts";
import { createSeatedConversation, readConversationMeta } from "../../src/host/seating.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { type DaemonProcess, type StartDaemonOptions, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const DESK_TEXT = "desk question";
const JOB_TEXT = "alpha job";
// The kinds of an entry that holds a team member's input: a lead's first input and a steered one.
const INPUT_KINDS = ["pi.user", "intern.steer"];

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const inProcess: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.signal("SIGTERM");
        await daemon.exited;
    }
    for (const daemon of inProcess.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Entry = { kind: string; data: unknown };
type Request = { firstUserText: string };

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const setDefaultModel = (env: HermeticEnv, isNamed: boolean) =>
    writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify(isNamed ? { defaultProvider: "faux", defaultModel: "faux-1" } : {}),
    );

function begin(env: HermeticEnv, options: Partial<StartDaemonOptions> = {}) {
    const daemon = startDaemon({ hermetic: env, workerThreads: 1, turnEndRule: false, ...options });
    daemons.push(daemon);
    return daemon;
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
    daemon.signal("SIGTERM");
    await daemon.exited;
}

async function killDaemon(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

const entriesOf = async (daemon: DaemonProcess, conversationId: string): Promise<Entry[]> =>
    ((await daemon.invoke("conversations.entries", { conversationId, limit: 100 })) as { entries: Entry[] }).entries;

const kindsOf = async (daemon: DaemonProcess, conversationId: string): Promise<string[]> =>
    (await entriesOf(daemon, conversationId)).map((entry) => entry.kind);

const countOf = async (daemon: DaemonProcess, conversationId: string, kind: string): Promise<number> =>
    (await kindsOf(daemon, conversationId)).filter((entryKind) => entryKind === kind).length;

async function requestsFor(daemon: DaemonProcess, text: string): Promise<number> {
    const requests = (await daemon.invoke("test.modelRequests", {})) as Request[];
    return requests.filter((request) => request.firstUserText.includes(text)).length;
}

async function submitUnanswered(daemon: DaemonProcess, conversationId: string, content: string): Promise<void> {
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content,
        requestId: content,
    })) as { submissionId: string };
    assert.deepEqual(await daemon.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS }), {
        state: "unanswered",
        reason: "no_model",
    });
}

// The front desk and a job's lead, each with an input and a notice, in a daemon whose folder names no default model.
async function startWaiting() {
    const env = await createHermeticEnv();
    envs.push(env);
    await setDefaultModel(env, false);
    const first = begin(env);
    await first.ready;
    const { conversationId: desk } = (await first.invoke("desk.get", {})) as { conversationId: string };
    await submitUnanswered(first, desk, DESK_TEXT);
    const job = (await first.invoke("jobs.create", { text: JOB_TEXT })) as JobView & { leadConversation: string };
    const waiting = [desk, job.leadConversation];
    for (const id of waiting) {
        await until(async () => (await countOf(first, id, NOTICE_KIND)) === 1, "the notice");
    }
    return { env, first, waiting };
}

async function expectStillWaiting(daemon: DaemonProcess, waiting: string[]): Promise<void> {
    for (const id of waiting) {
        const kinds = await kindsOf(daemon, id);
        assert.equal(kinds.filter((kind) => INPUT_KINDS.includes(kind)).length, 1);
        assert.equal(kinds.filter((kind) => kind === NOTICE_KIND).length, 1);
        assert.equal(kinds.filter((kind) => kind === "pi.assistant").length, 0);
    }
    assert.equal(await requestsFor(daemon, DESK_TEXT), 0);
    assert.equal(await requestsFor(daemon, JOB_TEXT), 0);
}

describe("conversations that wait for a model when the daemon restarts", () => {
    it("keeps the front desk and a lead waiting, with their input and one notice each, after a stop", async () => {
        const { env, first, waiting } = await startWaiting();
        await stopDaemon(first);

        const second = begin(env);
        await second.ready;

        await expectStillWaiting(second, waiting);
    });

    it("keeps them waiting with one notice each after kill -9", async () => {
        const { env, first, waiting } = await startWaiting();
        await killDaemon(first);

        const second = begin(env);
        await second.ready;

        await expectStillWaiting(second, waiting);
    });

    it("seats the fake model in each and answers each waiting input once when the folder names it at start", async () => {
        const { env, first, waiting } = await startWaiting();
        await stopDaemon(first);
        await setDefaultModel(env, true);

        const second = begin(env);
        await second.ready;

        for (const id of waiting) {
            await until(async () => (await countOf(second, id, "pi.assistant")) === 1, "the answer");
            assert.equal((await kindsOf(second, id)).filter((kind) => INPUT_KINDS.includes(kind)).length, 1);
            assert.equal(await countOf(second, id, NOTICE_KIND), 1);
        }
        assert.equal(await requestsFor(second, DESK_TEXT), 1);
        assert.equal(await requestsFor(second, JOB_TEXT), 1);
    });
});

// Passes every commit through except the one that records the notice, which never reaches the storage.
function refusingTheFact(storage: Storage): Storage {
    const isFactCommit = (writes: readonly StorageWrite[]) =>
        writes.some((write) => write.type === "entry" && write.value.kind === NOTICE_KIND);
    return new Proxy(storage, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property !== "commit") return value.bind(target);
            return (writes: readonly StorageWrite[], context: unknown) =>
                isFactCommit(writes)
                    ? Promise.reject(new Error("the commit of the fact is refused"))
                    : value.call(target, writes, context);
        },
    });
}

async function runInProcess(env: HermeticEnv, options: { isFactRefused: boolean }) {
    const fake = registerFauxProvider({ models: [{ id: "model-one" }] });
    fakes.push(fake);
    fake.setResponses([() => fauxAssistantMessage("ok")]);
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
                    id: fake.getModel().provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
        openStorage: async (database) => {
            const storage = await SqliteStorage.open(database);
            return options.isFactRefused ? refusingTheFact(storage) : storage;
        },
    });
    inProcess.push(daemon);
    await until(() => daemon.phase() === "ready", "the daemon to be ready");
    return { daemon, agents, host: (captured as ServiceContext).host };
}

const quietLogger = createLogger({ stream: { write: () => true } });

describe("a crash between the no_model commit and the commit of the fact", () => {
    it("sets the fact and writes one notice at the next start", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        await setDefaultModel(env, false);

        const crashing = await runInProcess(env, { isFactRefused: true });
        const { conversationId } = await createSeatedConversation(crashing.host, {
            scope: "no-model-restart",
            key: "conversation",
            job: { jobId: null, isLead: false, origin: { kind: "front_desk" }, depth: 0 },
            seat: crashing.agents.runtime().catalog.seatFor("bob", {}, "front_desk"),
            actor: { kind: "team_member", wayIn: "cli" },
        });
        const { submissionId } = await submitInput(crashing.host, conversationId, {
            content: DESK_TEXT,
            requestId: DESK_TEXT,
            busyMode: "reject",
        });
        assert.equal((await waitForSubmission(crashing.host, submissionId, WAIT_MS)).reason, "no_model");
        assert.equal((await readConversationMeta(crashing.host, conversationId))?.waitingForModel, undefined);
        await crashing.daemon.stop();
        inProcess.splice(0);

        const restarted = await runInProcess(env, { isFactRefused: false });

        const meta = await readConversationMeta(restarted.host, conversationId);
        assert.notEqual(meta?.waitingForModel, undefined);
        const entries = (await restarted.host.readEntries(conversationId, { limit: 100 })).entries;
        assert.equal(entries.filter((entry) => entry.kind === NOTICE_KIND).length, 1);
    });
});
