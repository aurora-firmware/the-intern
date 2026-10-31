import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import {
    type DaemonComponent,
    type DaemonOptions,
    type RunningDaemon,
    runDaemon,
    type ServiceContext,
} from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Storage } from "../../src/host/harness_host.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { createFakeModel, type FakeReply } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const TEAM_MEMBER = { actor: { kind: "team_member" } } as const;
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const BOUND_TEST_TIMEOUT_MS = STOP_BOUND_MS + 5_000;

type FakeModel = ReturnType<typeof createFakeModel>;

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(1_000)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// The tool holds its call open until the abort reaches it; `runs` counts how often it was entered.
function createWaitExtension(runs: { count: number }) {
    const waitTool = defineTool({
        name: "wait",
        description: "Waits until aborted",
        parameters: Type.Object({}),
        execute: async (_args, _api, toolContext) => {
            runs.count += 1;
            await new Promise<void>((resolve) => {
                if (toolContext.abortSignal?.aborted) resolve();
                toolContext.abortSignal?.addEventListener("abort", () => resolve());
            });
            return { output: [{ type: "text", text: "tool finished on its own" }] };
        },
    });
    return defineExtension({ name: "wait", tools: [waitTool] });
}

type Fixture = {
    env: HermeticEnv;
    lines: string[];
    modelId: string;
    start(overrides?: Partial<DaemonOptions>): RunningDaemon;
};

async function createFixture(reply: FakeReply = "ok"): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel((transcript) =>
        typeof reply === "string" || transcript.some((turn) => turn.role === "toolResult") ? "ok" : reply,
    );
    fakes.push(fake);
    const lines: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (chunk) => lines.push(String(chunk)) } });
    return {
        env,
        lines,
        modelId: `${fake.getModel().provider}/${fake.getModel().id}`,
        start(overrides = {}) {
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: env.env,
                homeDir: env.root,
                logger,
                prepareModels: () => modelsFor(fake),
                ...overrides,
            });
            daemons.push(daemon);
            return daemon;
        },
    };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function linesMatching(lines: string[], text: string): string[] {
    return lines.filter((line) => line.includes(text));
}

function capturingComponent(): { component: DaemonComponent; context: () => ServiceContext } {
    let captured: ServiceContext | undefined;
    return {
        component: {
            name: "capture",
            async start(ctx) {
                captured = ctx;
            },
        },
        context() {
            assert.ok(captured, "the capture component has started");
            return captured;
        },
    };
}

async function startToolCall(daemon: RunningDaemon, context: ServiceContext, modelId: string): Promise<string> {
    const conversationId = await context.host.createConversation({ agent: { model: modelId } });
    await daemon.catalogue.invoke(
        "conversations.submit",
        { conversationId, content: "wait", requestId: "wait-request" },
        TEAM_MEMBER,
    );
    return conversationId;
}

describe("runDaemon shutdown", () => {
    it("reports stopping, rejects calls, stops components in reverse order, closes the harness and settles with 0", async () => {
        const fixture = await createFixture();
        const stopped: string[] = [];
        const components: DaemonComponent[] = ["first", "second", "third"].map((name) => ({
            name,
            async stop() {
                stopped.push(name);
            },
        }));
        const capture = capturingComponent();
        const daemon = fixture.start({ components: [...components, capture.component] });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const { host } = capture.context();

        const exitStatus = await daemon.stop();

        assert.equal(exitStatus, 0);
        assert.equal(await daemon.exited, 0);
        assert.equal(daemon.phase(), "stopping");
        assert.deepEqual(stopped, ["third", "second", "first"]);
        assert.deepEqual(await host.closed, { reason: "closed" });
        assert.equal(await exists(join(fixture.env.stateDir, "owner.lock")), false);
        await assert.rejects(
            daemon.catalogue.invoke("conversations.list", {}, TEAM_MEMBER),
            (error: unknown) => error instanceof ServiceError && error.code === "unavailable",
        );
    });

    it("answers unavailable to a call made while the stop hooks are still running", async () => {
        const fixture = await createFixture();
        const hookEntered = Promise.withResolvers<void>();
        const hookRelease = Promise.withResolvers<void>();
        const slow: DaemonComponent = {
            name: "slow",
            async stop() {
                hookEntered.resolve();
                await hookRelease.promise;
            },
        };
        const daemon = fixture.start({ components: [slow] });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        const stopping = daemon.stop();
        await hookEntered.promise;

        assert.equal(daemon.phase(), "stopping");
        await assert.rejects(
            daemon.catalogue.invoke("conversations.list", {}, TEAM_MEMBER),
            (error: unknown) => error instanceof ServiceError && error.code === "unavailable",
        );
        hookRelease.resolve();
        assert.equal(await stopping, 0);
    });

    it("keeps exited pending when stop is called again while the first shutdown is still running", async () => {
        const fixture = await createFixture();
        const hookEntered = Promise.withResolvers<void>();
        const hookRelease = Promise.withResolvers<void>();
        const capture = capturingComponent();
        const slow: DaemonComponent = {
            name: "slow",
            async stop() {
                hookEntered.resolve();
                await hookRelease.promise;
            },
        };
        const daemon = fixture.start({ components: [slow, capture.component] });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const { host } = capture.context();
        let isSettled = false;
        daemon.exited.then(() => {
            isSettled = true;
        });

        const first = daemon.stop();
        await hookEntered.promise;
        const second = daemon.stop();
        await sleep(100);

        assert.equal(isSettled, false, "exited settled before the first shutdown finished");
        hookRelease.resolve();
        assert.equal(await first, 0);
        assert.equal(await second, 0);
        assert.deepEqual(await host.closed, { reason: "closed" });
        assert.equal(await exists(join(fixture.env.stateDir, "owner.lock")), false);
    });

    it("records no abort during a tool call so the restarted run resumes with an interrupted result", async () => {
        const fixture = await createFixture({ toolCall: { name: "wait", arguments: {} } });
        const firstRuns = { count: 0 };
        const capture = capturingComponent();
        const first = fixture.start({
            components: [{ name: "wait", extensions: [createWaitExtension(firstRuns)] }, capture.component],
        });
        await until(() => first.phase() === "ready", "the first daemon to be ready");
        const conversationId = await startToolCall(first, capture.context(), fixture.modelId);
        await until(() => firstRuns.count === 1, "the tool call to start");

        assert.equal(await first.stop(), 0);

        const secondRuns = { count: 0 };
        const secondCapture = capturingComponent();
        const second = fixture.start({
            components: [{ name: "wait", extensions: [createWaitExtension(secondRuns)] }, secondCapture.component],
        });
        await until(() => second.phase() === "ready", "the second daemon to be ready");
        const { host } = secondCapture.context();
        const resultText = async (): Promise<string | undefined> => {
            const { entries } = await host.readEntries(conversationId, { limit: 50 });
            const result = entries.find((entry) => entry.kind === "pi.tool-result");
            return result === undefined ? undefined : JSON.stringify(result.data);
        };
        await until(async () => (await resultText()) !== undefined, "the interrupted result");

        const text = await resultText();
        assert.match(text ?? "", /interrupted/);
        assert.doesNotMatch(text ?? "", /tool finished on its own/);
        assert.equal(secondRuns.count, 0);
        assert.equal(linesMatching(fixture.lines, "abort").length, 0);
    });

    it("settles exited with a non-zero status and logs an error when a stop hook ignores its abort for 10 seconds", {
        timeout: BOUND_TEST_TIMEOUT_MS,
    }, async () => {
        const fixture = await createFixture();
        const stuck: DaemonComponent = { name: "stuck", stop: () => new Promise<void>(() => {}) };
        const daemon = fixture.start({ components: [stuck] });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const stoppedAt = Date.now();

        const exitStatus = await daemon.stop();

        assert.notEqual(exitStatus, 0);
        assert.equal(await daemon.exited, exitStatus);
        assert.ok(Date.now() - stoppedAt >= STOP_BOUND_MS - 100, "waited the full bound");
        assert.equal(linesMatching(fixture.lines, "ERROR").length, 1);
        assert.match(linesMatching(fixture.lines, "ERROR")[0], /shutdown/);
    });
});

describe("runDaemon storage failure", () => {
    it("logs the error, stops accepting calls and settles non-zero without reopening the database", async () => {
        const fixture = await createFixture();
        const storageSwitch = { isFailing: false };
        let openCount = 0;
        const stopped: string[] = [];
        const capture = capturingComponent();
        const daemon = fixture.start({
            components: [
                {
                    name: "recorder",
                    async stop() {
                        stopped.push("recorder");
                    },
                },
                capture.component,
            ],
            openStorage: async (file) => {
                openCount += 1;
                return failingOnDemand(await openNodeSqliteStorage(file), storageSwitch);
            },
        });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const { host } = capture.context();

        storageSwitch.isFailing = true;
        await host.createConversation({ agent: { model: fixture.modelId } }).catch(() => undefined);
        const exitStatus = await Promise.race([daemon.exited, sleep(STOP_BOUND_MS).then(() => "timed out")]);

        assert.notEqual(exitStatus, 0);
        assert.notEqual(exitStatus, "timed out");
        assert.equal(daemon.phase(), "stopping");
        assert.equal(openCount, 1);
        assert.deepEqual(stopped, ["recorder"]);
        assert.equal(linesMatching(fixture.lines, "storage failed").length, 1);
        assert.match(linesMatching(fixture.lines, "storage failed")[0], /storage commit refused/);
        assert.equal(await exists(join(fixture.env.stateDir, "owner.lock")), false);
        await assert.rejects(
            daemon.catalogue.invoke("conversations.list", {}, TEAM_MEMBER),
            (error: unknown) => error instanceof ServiceError && error.code === "unavailable",
        );
    });
});

describe("runDaemon storage failure during a requested stop", () => {
    it("settles non-zero when stop is called while the storage-failure shutdown is running", async () => {
        const fixture = await createFixture();
        const storageSwitch = { isFailing: false };
        const hookEntered = Promise.withResolvers<void>();
        const hookRelease = Promise.withResolvers<void>();
        const capture = capturingComponent();
        const slow: DaemonComponent = {
            name: "slow",
            async stop() {
                hookEntered.resolve();
                await hookRelease.promise;
            },
        };
        const daemon = fixture.start({
            components: [slow, capture.component],
            openStorage: async (file) => failingOnDemand(await openNodeSqliteStorage(file), storageSwitch),
        });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");
        const { host } = capture.context();

        storageSwitch.isFailing = true;
        await host.createConversation({ agent: { model: fixture.modelId } }).catch(() => undefined);
        await hookEntered.promise;
        const stopping = daemon.stop();
        await sleep(100);
        hookRelease.resolve();

        assert.notEqual(await stopping, 0);
        assert.notEqual(await daemon.exited, 0);
    });
});

describe("runDaemon host closed rejection", () => {
    it("logs the error and settles non-zero when host.closed rejects after ready", async () => {
        const fixture = await createFixture();
        const rejection = Promise.withResolvers<never>();
        const stopped: string[] = [];
        // The daemon watches `host.closed` once the start hooks are done, so a hook can swap in a promise that rejects.
        const swapClosed: DaemonComponent = {
            name: "swap-closed",
            async start(ctx) {
                (ctx.host as { closed: Promise<unknown> }).closed = rejection.promise;
            },
        };
        const daemon = fixture.start({
            components: [
                {
                    name: "recorder",
                    async stop() {
                        stopped.push("recorder");
                    },
                },
                swapClosed,
            ],
        });
        await until(() => daemon.phase() === "ready", "the daemon to be ready");

        rejection.reject(new Error("harness session broke"));

        assert.notEqual(await daemon.exited, 0);
        assert.deepEqual(stopped, ["recorder"]);
        assert.match(linesMatching(fixture.lines, "daemon failed after ready")[0] ?? "", /harness session broke/);
    });
});

function failingOnDemand(storage: Storage, storageSwitch: { isFailing: boolean }): Storage {
    return new Proxy(storage, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property === "commit" && storageSwitch.isFailing) {
                return () => Promise.reject(new Error("storage commit refused"));
            }
            return value.bind(target);
        },
    });
}
