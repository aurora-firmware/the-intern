import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    type Extension,
    type HarnessHost,
    internalHarness,
    openHarnessHost,
    resolveHarnessSettings,
    type Storage,
} from "../../src/host/harness_host.ts";
import { createFakeModel, type FakeReply, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const ctx = BACKGROUND_CONTEXT;
const OWNER_ONLY_FILE_MODE = 0o600;

type FakeModel = ReturnType<typeof createFakeModel>;

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

async function makeEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

function makeFake(reply: (transcript: FakeTranscript) => FakeReply, delayMs?: () => number): FakeModel {
    const fake = createFakeModel(reply, delayMs ? { delayMs } : undefined);
    fakes.push(fake);
    return fake;
}

// createFakeModel registers the fake in pi-ai's global registry; the harness needs it inside a Models collection.
function modelsFor(fake: FakeModel): Models {
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation, "the fake model's api is registered");
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return models;
}

const modelNameOf = (fake: FakeModel): string => `${fake.getModel().provider}/${fake.getModel().id}`;

const silentLogger = createLogger({ stream: { write: () => true } });

const whereTool = defineTool({
    name: "where",
    description: "Reports the directory the call runs in",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
        const resolved = await api.env?.absolutePath(".", context);
        return { output: [{ type: "text", text: `cwd=${resolved?.ok ? resolved.value : "none"}` }] };
    },
});
const probeExtension = defineExtension({ name: "probe", tools: [whereTool] });

type OpenOptions = {
    databaseFile: string;
    fake: FakeModel;
    defaultCwd?: string;
    extensions?: readonly Extension[];
    openStorage?: (file: string) => Promise<Storage>;
};

async function openHost(options: OpenOptions): Promise<HarnessHost> {
    const host = await openHarnessHost({
        databaseFile: options.databaseFile,
        models: modelsFor(options.fake),
        harnessSettings: {},
        extensions: options.extensions ?? [],
        defaultCwd: options.defaultCwd ?? process.cwd(),
        logger: silentLogger,
        ...(options.openStorage ? { openStorage: options.openStorage } : {}),
    });
    hosts.push(host);
    return host;
}

async function answer(host: HarnessHost, id: string, text: string): Promise<void> {
    const conversation = await internalHarness(host).conversation(Number(id) as never, ctx);
    assert.ok(conversation, "conversation exists");
    const submission = await conversation.submit({ type: "input", content: text }, ctx);
    const settled = await submission.wait(ctx);
    assert.equal(settled.status, "done");
}

async function allEntries(host: HarnessHost, id: string, limit = 100) {
    const entries = [];
    let after: string | undefined;
    do {
        const page = await host.readEntries(id, after === undefined ? { limit } : { after, limit });
        entries.push(...page.entries);
        after = page.next;
    } while (after !== undefined);
    return entries;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("condition was not met in time");
}

describe("resolveHarnessSettings", () => {
    it("resolves restartLimit to Infinity and keeps the mapped settings and the extensions", () => {
        const settings = resolveHarnessSettings({ retry: { maxRetries: 2 } }, [probeExtension]);

        assert.equal(settings.restartLimit, Number.POSITIVE_INFINITY);
        assert.deepEqual(settings.retry, { maxRetries: 2 });
        assert.deepEqual(settings.extensions, [probeExtension]);
    });

    it("resolves restartLimit to Infinity even when the mapping carries another limit", () => {
        const mappingWithLimit = { restartLimit: 3 } as Record<string, unknown>;

        assert.equal(resolveHarnessSettings(mappingWithLimit, []).restartLimit, Number.POSITIVE_INFINITY);
    });
});

describe("openHarnessHost", () => {
    it("makes the database file and its wal and shm files owner-only", async () => {
        const env = await makeEnv();
        const databaseFile = join(env.root, "state.sqlite");
        const host = await openHost({ databaseFile, fake: makeFake(() => "hello") });
        const id = await host.createConversation({ agent: { model: modelNameOf(fakes[0] as FakeModel) } });
        await answer(host, id, "hi");

        for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
            assert.equal((await stat(file)).mode & 0o777, OWNER_ONLY_FILE_MODE, file);
        }
    });

    it("installs every given extension into the default selection", async () => {
        const env = await makeEnv();
        const fake = makeFake(() => "hello");
        const host = await openHost({
            databaseFile: join(env.root, "state.sqlite"),
            fake,
            extensions: [probeExtension],
        });
        const id = await host.createConversation({ agent: { model: modelNameOf(fake) } });

        const conversation = await internalHarness(host).conversation(Number(id) as never, ctx);
        const agent = await conversation?.agent(ctx);
        assert.deepEqual(
            agent?.extensions.map((extension) => extension.name),
            ["probe"],
        );
    });

    it("resumes nothing until resume is called and never parks a task however often it was cut off", async () => {
        const env = await makeEnv();
        const databaseFile = join(env.root, "state.sqlite");
        const fake = makeFake(
            () => "hello",
            () => 60_000,
        );
        const cutOffCountAboveDefaultRestartLimit = 7;
        let conversationId = "";

        for (let round = 0; round < cutOffCountAboveDefaultRestartLimit; round++) {
            const failing = { isFailing: false };
            const host = await openHost({
                databaseFile,
                fake,
                openStorage: async (file) => failingOnDemand(await openNodeSqliteStorage(file), failing),
            });
            const harness = internalHarness(host);
            if (round === 0) {
                conversationId = await host.createConversation({ agent: { model: modelNameOf(fake) } });
                const conversation = await harness.conversation(Number(conversationId) as never, ctx);
                await conversation?.submit({ type: "input", content: "hi" }, ctx);
            } else {
                assert.equal((await harness.inspect(ctx)).scheduling, "paused", `round ${round} before resume`);
            }

            host.resume();
            await waitFor(async () => (await harness.inspect(ctx)).tasks.some((task) => task.state.kind === "running"));

            failing.isFailing = true;
            await host.createConversation({ agent: { model: "faux/faux-1" } }).catch(() => undefined);
            assert.equal((await host.closed).reason, "failed");
        }

        const final = await openHost({ databaseFile, fake });
        const { tasks } = await internalHarness(final).inspect(ctx);
        assert.equal(tasks.length, 1);
        assert.notEqual(tasks[0]?.state.kind, "blocked");
    });

    it("settles closed as failed with the error when the storage fails a commit", async () => {
        const env = await makeEnv();
        const failing = { isFailing: true };
        const host = await openHost({
            databaseFile: join(env.root, "state.sqlite"),
            fake: makeFake(() => "hello"),
            openStorage: async (file) => failingOnDemand(await openNodeSqliteStorage(file), failing),
        });

        await assert.rejects(host.createConversation({ agent: { model: "faux/faux-1" } }));

        const end = await host.closed;
        assert.equal(end.reason, "failed");
        assert.match(String((end as { error: unknown }).error), /storage commit refused/);
    });

    it("settles closed as closed after close", async () => {
        const env = await makeEnv();
        const host = await openHost({
            databaseFile: join(env.root, "state.sqlite"),
            fake: makeFake(() => "hello"),
        });

        await host.close();

        assert.deepEqual(await host.closed, { reason: "closed" });
    });
});

function failingOnDemand(storage: Storage, switchBox: { isFailing: boolean }): Storage {
    return new Proxy(storage, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property === "commit") {
                return (...args: unknown[]) =>
                    switchBox.isFailing
                        ? Promise.reject(new Error("storage commit refused"))
                        : value.apply(target, args);
            }
            return value.bind(target);
        },
    });
}

describe("conversations", () => {
    it("lists the same conversation with the same entries after the host is closed and opened again", async () => {
        const env = await makeEnv();
        const databaseFile = join(env.root, "state.sqlite");
        const fake = makeFake(() => "hello");
        const first = await openHost({ databaseFile, fake });
        const id = await first.createConversation({ agent: { model: modelNameOf(fake) } });
        await answer(first, id, "hi");
        const entriesBefore = await allEntries(first, id);
        await first.close();

        const second = await openHost({ databaseFile, fake });

        assert.deepEqual(await second.listConversations(), [{ id, busy: false }]);
        assert.deepEqual(await second.conversationInfo(id), { id, busy: false });
        assert.deepEqual(await allEntries(second, id), entriesBefore);
        assert.deepEqual(
            entriesBefore.map((entry) => entry.kind),
            ["pi.user", "pi.assistant"],
        );
    });

    it("returns no info for a conversation that does not exist", async () => {
        const env = await makeEnv();
        const host = await openHost({ databaseFile: join(env.root, "state.sqlite"), fake: makeFake(() => "hello") });

        assert.equal(await host.conversationInfo("424242"), undefined);
        assert.equal(await host.conversationInfo("not-a-number"), undefined);
    });

    it("reports a conversation as busy while its run is in progress", async () => {
        const env = await makeEnv();
        const fake = makeFake(
            () => "hello",
            () => 60_000,
        );
        const host = await openHost({ databaseFile: join(env.root, "state.sqlite"), fake });
        const id = await host.createConversation({ agent: { model: modelNameOf(fake) } });
        const conversation = await internalHarness(host).conversation(Number(id) as never, ctx);

        await conversation?.submit({ type: "input", content: "hi" }, ctx);

        await waitFor(async () => (await host.conversationInfo(id))?.busy === true);
        assert.deepEqual(await host.listConversations(), [{ id, busy: true }]);
    });

    it("reads entries oldest first in pages", async () => {
        const env = await makeEnv();
        const fake = makeFake(() => "hello");
        const host = await openHost({ databaseFile: join(env.root, "state.sqlite"), fake });
        const id = await host.createConversation({ agent: { model: modelNameOf(fake) } });
        await answer(host, id, "one");
        await answer(host, id, "two");

        const firstPage = await host.readEntries(id, { limit: 3 });

        assert.equal(firstPage.entries.length, 3);
        assert.notEqual(firstPage.next, undefined);
        const paged = await allEntries(host, id, 3);
        const whole = await allEntries(host, id, 100);
        assert.deepEqual(paged, whole);
        assert.deepEqual(
            paged.map((entry) => entry.id),
            [...paged.map((entry) => entry.id)].sort((a, b) => Number(a) - Number(b)),
        );
    });

    it("keeps entries from before a reset in readEntries and leaves them out of readContext", async () => {
        const env = await makeEnv();
        const fake = makeFake(() => "hello");
        const host = await openHost({ databaseFile: join(env.root, "state.sqlite"), fake });
        const id = await host.createConversation({ agent: { model: modelNameOf(fake) } });
        await answer(host, id, "before the reset");
        const idsBeforeReset = (await allEntries(host, id)).map((entry) => entry.id);
        const conversation = await internalHarness(host).conversation(Number(id) as never, ctx);
        await conversation?.reset(undefined, ctx);
        await answer(host, id, "after the reset");

        const readEntryIds = (await allEntries(host, id)).map((entry) => entry.id);
        const contextIds = (await host.readContext(id)).map((entry) => entry.id);

        for (const earlier of idsBeforeReset) {
            assert.ok(readEntryIds.includes(earlier), `readEntries keeps entry ${earlier}`);
            assert.ok(!contextIds.includes(earlier), `readContext leaves out entry ${earlier}`);
        }
        assert.ok(contextIds.length > 0);
    });
});

describe("tool calls", () => {
    const callWhereOnce = (transcript: FakeTranscript): FakeReply =>
        transcript.some((turn) => turn.role === "toolResult") ? "done" : { toolCall: { name: "where", arguments: {} } };

    async function toolResultText(host: HarnessHost, id: string): Promise<string> {
        const entries = await allEntries(host, id);
        const result = entries.find((entry) => entry.kind === "pi.tool-result");
        assert.ok(result, "the conversation holds a tool result");
        return JSON.stringify(result.data);
    }

    it("runs a tool call in the conversation's cwd", async () => {
        const env = await makeEnv();
        const fake = makeFake(callWhereOnce);
        const host = await openHost({
            databaseFile: join(env.root, "state.sqlite"),
            fake,
            extensions: [probeExtension],
            defaultCwd: env.stateDir,
        });
        const id = await host.createConversation({ agent: { model: modelNameOf(fake), cwd: env.dataDir } });

        await answer(host, id, "where are you");

        assert.match(await toolResultText(host, id), new RegExp(`cwd=${env.dataDir}`));
    });

    it("runs a tool call in the default cwd when the conversation has none", async () => {
        const env = await makeEnv();
        const fake = makeFake(callWhereOnce);
        const host = await openHost({
            databaseFile: join(env.root, "state.sqlite"),
            fake,
            extensions: [probeExtension],
            defaultCwd: env.stateDir,
        });
        const id = await host.createConversation({ agent: { model: modelNameOf(fake) } });

        await answer(host, id, "where are you");

        assert.match(await toolResultText(host, id), new RegExp(`cwd=${env.stateDir}`));
    });
});
