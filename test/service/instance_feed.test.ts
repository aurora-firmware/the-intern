import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type Admission, createAdmission } from "../../src/admission/admission.ts";
import { createAdmissionGate } from "../../src/admission/admission_extension.ts";
import { defineConfigSection, loadConfig } from "../../src/config/config_file.ts";
import { type ConfigStore, createConfigStore } from "../../src/config/config_writer.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    createInstanceFeed,
    type InstanceDelta,
    type InstanceFeed,
    type InstanceSnapshot,
} from "../../src/feed/instance_feed.ts";
import { createObservationFeed, type ObservationFeed, type Subscription } from "../../src/feed/observation_feed.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { feedOperations } from "../../src/service/feed_operations.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const TEAM_MEMBER: Caller = { actor: { kind: "team_member" } };
const NEXT_TIMEOUT_MS = 5000;
const SUBMISSION_TIMEOUT_MS = 10_000;
const RUN_DELAY_MS = 100;

type FakeModel = ReturnType<typeof createFakeModel>;
type Sub = Subscription<InstanceSnapshot, InstanceDelta>;
type Fixture = {
    host: HarnessHost;
    admission: Admission;
    config: ConfigStore;
    modelId: string;
    open(maxPending?: number): Promise<InstanceFeed>;
};

const labelSection = defineConfigSection<{ label: string }>({
    name: "label",
    defaults: () => ({ label: "none" }),
    parse: (table) => ({ label: (table as { label?: string }).label ?? "none" }),
    serialize: (value) => ({ label: value.label }),
});

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const admissions: Admission[] = [];
const feeds: { close(): void }[] = [];
const directories: string[] = [];

afterEach(async () => {
    for (const feed of feeds.splice(0)) feed.close();
    for (const admission of admissions.splice(0)) admission.stop();
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

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

async function openFixture(capacity = 2): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => RUN_DELAY_MS });
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const gate = createAdmissionGate();
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [gate.extension],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const admission = createAdmission({ host, capacity, logger, gate });
    admissions.push(admission);
    const directory = await mkdtemp(join(tmpdir(), "instance-feed-"));
    directories.push(directory);
    const file = join(directory, "config.toml");
    const config = await createConfigStore(file, [labelSection], await loadConfig(file, [labelSection]));
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    return {
        host,
        admission,
        config,
        modelId,
        async open(maxPending) {
            const feed = await createInstanceFeed({ host, admission, config, ...(maxPending && { maxPending }) });
            feeds.push(feed);
            return feed;
        },
    };
}

async function nextDelta(subscription: Sub): Promise<InstanceDelta> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for the next delta")), NEXT_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([subscription.next(), timeout]);
        assert.ok("delta" in result, "the subscription stays open");
        return result.delta;
    } finally {
        clearTimeout(timer);
    }
}

async function collectUntil(subscription: Sub, isDone: (deltas: InstanceDelta[]) => boolean): Promise<InstanceDelta[]> {
    const deltas: InstanceDelta[] = [];
    while (!isDone(deltas)) deltas.push(await nextDelta(subscription));
    return deltas;
}

async function send(fixture: Fixture, conversationId: string): Promise<void> {
    const { submissionId } = await submitInput(fixture.host, conversationId, {
        content: "hello",
        requestId: `req-${conversationId}`,
        busyMode: "followUp",
    });
    await waitForSubmission(fixture.host, submissionId, SUBMISSION_TIMEOUT_MS);
}

describe("the instance feed", () => {
    it("snapshots every conversation with its status and the worker threads", async () => {
        const fixture = await openFixture(3);
        const first = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const second = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const feed = await fixture.open();

        const { snapshot } = feed.subscribe();

        assert.deepEqual(snapshot.conversations.map((conversation) => conversation.id).sort(), [first, second].sort());
        assert.ok(snapshot.conversations.every((conversation) => conversation.status === "idle"));
        assert.deepEqual(snapshot.workerThreads, { count: 3, inUse: 0 });
        assert.deepEqual(snapshot.admission, fixture.admission.state());
    });

    it("reports the status of a running conversation in a later snapshot", async () => {
        const fixture = await openFixture();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const feed = await fixture.open();
        const watcher = feed.subscribe();
        const sending = send(fixture, id);
        await collectUntil(watcher, (deltas) => deltas.some((delta) => delta.type === "run_started"));

        const { snapshot } = feed.subscribe();
        await sending;

        assert.equal(snapshot.conversations.find((conversation) => conversation.id === id)?.status, "running");
    });

    it("delivers created, run, admission and settings deltas in order with increasing seq", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        await send(fixture, id);
        await fixture.config.change(labelSection, { label: "changed" });

        const deltas = await collectUntil(subscription, (all) =>
            all.some((delta) => delta.type === "settings_changed"),
        );
        const types = deltas.map((delta) => delta.type);
        assert.equal(types[0], "conversation_created");
        assert.ok(types.indexOf("run_started") < types.indexOf("run_finished"));
        assert.ok(types.includes("admission_changed"));
        assert.deepEqual(deltas.at(-1), { type: "settings_changed", section: "label", seq: deltas.length });
        assert.deepEqual(
            deltas.map((delta) => delta.seq),
            deltas.map((_, index) => index + 1),
        );
        const created = deltas[0];
        assert.ok(created?.type === "conversation_created" && created.conversationId === id);
    });

    it("delivers every delta to every instance subscriber", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open();
        const first = feed.subscribe();
        const second = feed.subscribe();

        await fixture.config.change(labelSection, { label: "x" });

        assert.deepEqual(await nextDelta(first), { seq: 1, type: "settings_changed", section: "label" });
        assert.deepEqual(await nextDelta(second), { seq: 1, type: "settings_changed", section: "label" });
    });

    it("closes a subscriber with reason lagging without delaying a run", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open(2);
        const lagging = feed.subscribe();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });

        await send(fixture, id);

        assert.deepEqual(await lagging.next(), { closed: "lagging" });
    });

    it("closes subscribers with reason stopped when the feed closes and refuses new ones", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        feed.close();

        assert.deepEqual(await subscription.next(), { closed: "stopped" });
        assert.throws(() => feed.subscribe(), /closed/);
    });
});

describe("feed.subscribe", () => {
    async function context(fixture: Fixture): Promise<{
        feed: ObservationFeed;
        instanceFeed: InstanceFeed;
        host: HarnessHost;
    }> {
        const feed = createObservationFeed({ host: fixture.host });
        feeds.push(feed);
        return { feed, instanceFeed: await fixture.open(), host: fixture.host };
    }
    const subscribe = feedOperations.find((operation) => operation.name === "feed.subscribe");

    it("is a read operation", () => {
        assert.equal(subscribe?.kind, "read");
    });

    it("returns the conversation subscription for a known conversation", async () => {
        const fixture = await openFixture();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });

        const subscription = await subscribe?.run(
            await context(fixture),
            {
                scope: "conversation",
                conversationId: id,
            },
            TEAM_MEMBER,
        );

        assert.deepEqual(subscription.snapshot.entries, []);
        assert.equal(typeof subscription.next, "function");
    });

    it("returns the instance subscription for scope instance", async () => {
        const fixture = await openFixture();
        const subscription = await subscribe?.run(await context(fixture), { scope: "instance" }, TEAM_MEMBER);
        assert.deepEqual(subscription.snapshot.workerThreads, { count: 2, inUse: 0 });
    });

    it("rejects an unknown conversation with not_found", async () => {
        const fixture = await openFixture();
        const ctx = await context(fixture);
        for (const conversationId of ["999", "nope"]) {
            await assert.rejects(
                async () => subscribe?.run(ctx, { scope: "conversation", conversationId }, TEAM_MEMBER),
                (error) => error instanceof ServiceError && error.code === "not_found",
            );
        }
    });

    it("rejects an input with an unknown scope", () => {
        assert.throws(() => subscribe?.parse({ scope: "galaxy" }), /scope/);
    });
});
