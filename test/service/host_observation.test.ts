import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    abortConversation,
    compactConversation,
    submitInput,
    waitForSubmission,
} from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import {
    type ConversationFrame,
    type InstanceEvent,
    watchConversation,
    watchInstance,
} from "../../src/host/host_observation.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BUSY_DELAY_MS = 400;
const POLL_LIMIT = 200;
const POLL_PAUSE_MS = 25;
const SETTLE_PAUSE_MS = 150;

type FakeModel = ReturnType<typeof createFakeModel>;
type Fixture = { host: HarnessHost; agentModel: string };

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

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

async function openFixture(delayMs = 0, harnessSettings: Record<string, unknown> = {}): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => delayMs });
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings,
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    return { host, agentModel: `${fake.getModel().provider}/${fake.getModel().id}` };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt++) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
    }
    assert.fail(`timed out waiting for ${what}`);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function sendAndSettle(host: HarnessHost, conversationId: string, content: string): Promise<void> {
    const { submissionId } = await submitInput(host, conversationId, {
        content,
        requestId: `req-${content}`,
        busyMode: "followUp",
    });
    await waitForSubmission(host, submissionId, 10_000);
}

describe("watchConversation", () => {
    it("starts from the newest entry id when the attached view holds the compaction entry before kept entries", async () => {
        const { host, agentModel } = await openFixture(0, { compaction: { keepRecentTokens: 1 } });
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");
        await sendAndSettle(host, conversationId, "second");
        await compactConversation(host, conversationId);
        const stored = (await host.readEntries(conversationId, { limit: 100 })).entries;
        const compaction = stored.find((entry) => entry.kind === "pi.compaction");
        const frames: ConversationFrame[] = [];

        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));
        await sendAndSettle(host, conversationId, "third");
        await pause(SETTLE_PAUSE_MS);
        await watch.stop();

        assert.equal(watch.snapshot.newestEntryId, compaction?.id);
        const delivered = frames.flatMap((frame) => frame.entries);
        assert.ok(delivered.length > 0);
        assert.ok(delivered.every((entry) => Number(entry.id) > Number(compaction?.id)));
    });

    it("delivers the compaction entry a compaction adds, once, though kept entries with lower ids follow it", async () => {
        const { host, agentModel } = await openFixture(0, { compaction: { keepRecentTokens: 1 } });
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");
        await sendAndSettle(host, conversationId, "second");
        const frames: ConversationFrame[] = [];
        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));

        await compactConversation(host, conversationId);
        await pause(SETTLE_PAUSE_MS);
        await watch.stop();

        const delivered = frames.flatMap((frame) => frame.entries);
        assert.deepEqual(
            delivered.map((entry) => entry.kind),
            ["pi.compaction"],
        );
    });

    it("returns the newest entry id and the state as the snapshot, then one frame per commit without replay", async () => {
        const { host, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");
        const newestBefore = (await host.readEntries(conversationId, { limit: 1, order: "descending" })).entries[0];
        const frames: ConversationFrame[] = [];

        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));
        await pause(SETTLE_PAUSE_MS);
        assert.equal(frames.length, 0, "nothing is replayed at attachment");
        assert.deepEqual(Object.keys(watch.snapshot).sort(), ["busy", "inbox", "live", "newestEntryId"]);
        assert.equal(watch.snapshot.newestEntryId, newestBefore?.id);
        assert.equal(watch.snapshot.busy, false);

        await sendAndSettle(host, conversationId, "second");
        await until(() => JSON.stringify(frames.map((frame) => frame.entries)).includes("second"), "new frames");
        await watch.stop();

        assert.ok(
            frames.every((frame) => !("ops" in frame)),
            "a frame carries no operations",
        );
        assert.deepEqual(JSON.parse(JSON.stringify(frames)), frames, "frames are plain JSON");
    });

    it("gives each frame only the entries its commit added, which together are the entries added after attachment", async () => {
        const { host, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "first");
        const frames: ConversationFrame[] = [];
        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));

        await sendAndSettle(host, conversationId, "second");
        await pause(SETTLE_PAUSE_MS);
        await watch.stop();

        const delivered = frames.flatMap((frame) => frame.entries);
        const stored = (await host.readEntries(conversationId, { limit: 100 })).entries;
        const added = stored.filter((entry) => Number(entry.id) > Number(watch.snapshot.newestEntryId));
        assert.ok(added.length > 0);
        assert.deepEqual(
            delivered.map(({ id, kind, data }) => ({ id, kind, data })),
            added,
        );
        assert.ok(
            frames.some((frame) => frame.entries.length === 0),
            "a commit that adds no entry gives a frame with none",
        );
    });

    it("delivers exactly one frame for each commit that changes the conversation's view", async () => {
        const { host, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const frames: ConversationFrame[] = [];
        let viewCommits = 0;
        const unsubscribe = internalHarness(host).subscribeCommits((publication) => {
            const isViewChange = publication.changes.some(
                (change) =>
                    (change.type === "entry" && String(change.value.conversationId) === conversationId) ||
                    (change.type === "document" &&
                        String(change.conversationId) === conversationId &&
                        change.ops.length > 0),
            );
            if (isViewChange) viewCommits++;
        });
        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));

        await sendAndSettle(host, conversationId, "count me");
        await until(() => frames.length >= viewCommits && viewCommits > 0, "frames for every view commit");
        await pause(SETTLE_PAUSE_MS);
        await watch.stop();
        unsubscribe();

        assert.equal(frames.length, viewCommits);
    });

    it("reports busy in the snapshot and in each frame according to the run in that frame's own view", async () => {
        const { host, agentModel } = await openFixture(BUSY_DELAY_MS);
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await submitInput(host, conversationId, { content: "slow", requestId: "slow-1", busyMode: "followUp" });
        await until(async () => (await host.conversationInfo(conversationId))?.busy === true, "the run to start");
        const frames: ConversationFrame[] = [];

        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));
        await until(
            async () => (await host.conversationInfo(conversationId))?.busy === false && frames.length > 0,
            "the run to finish",
        );
        await pause(SETTLE_PAUSE_MS);
        await watch.stop();

        assert.equal(watch.snapshot.busy, true);
        assert.equal(frames.at(-1)?.view.busy, false);
        for (const frame of frames) {
            const live = frame.view.live as { run?: unknown } | null;
            assert.equal(frame.view.busy, live?.run !== undefined, "busy agrees with the run in the same view");
        }
    });

    it("delivers no frame after stop is called", async () => {
        const { host, agentModel } = await openFixture();
        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        const frames: ConversationFrame[] = [];
        const watch = await watchConversation(host, conversationId, (frame) => frames.push(frame));

        await watch.stop();
        await sendAndSettle(host, conversationId, "after stop");
        await pause(SETTLE_PAUSE_MS);

        assert.equal(frames.length, 0);
    });

    it("rejects when the conversation does not exist", async () => {
        const { host } = await openFixture();

        await assert.rejects(() => watchConversation(host, "999", () => {}), /does not exist/);
    });
});

describe("watchInstance", () => {
    it("delivers conversation_created, run_started and run_finished with the conversation id", async () => {
        const { host, agentModel } = await openFixture();
        const events: InstanceEvent[] = [];
        const watch = await watchInstance(host, (event) => events.push(event));

        const conversationId = await host.createConversation({ agent: { model: agentModel } });
        await sendAndSettle(host, conversationId, "work");
        await until(() => events.some((event) => event.type === "run_finished"), "run_finished");
        watch.stop();

        assert.deepEqual(events, [
            { type: "conversation_created", conversationId },
            { type: "run_started", conversationId },
            { type: "run_finished", conversationId },
        ]);
    });

    it("lists every conversation with its busy state in the snapshot", async () => {
        const { host, agentModel } = await openFixture(BUSY_DELAY_MS);
        const idleId = await host.createConversation({ agent: { model: agentModel } });
        const busyId = await host.createConversation({ agent: { model: agentModel } });
        await submitInput(host, busyId, { content: "slow", requestId: "slow-1", busyMode: "followUp" });
        await until(async () => (await host.conversationInfo(busyId))?.busy === true, "the run to start");

        const watch = await watchInstance(host, () => {});
        watch.stop();
        await abortConversation(host, busyId);

        assert.deepEqual(
            [...watch.snapshot.conversations].sort((a, b) => a.id.localeCompare(b.id)),
            [
                { id: idleId, busy: false },
                { id: busyId, busy: true },
            ].sort((a, b) => a.id.localeCompare(b.id)),
        );
    });

    it("delivers no event after stop is called", async () => {
        const { host, agentModel } = await openFixture();
        const events: InstanceEvent[] = [];
        const watch = await watchInstance(host, (event) => events.push(event));

        watch.stop();
        await host.createConversation({ agent: { model: agentModel } });
        await pause(SETTLE_PAUSE_MS);

        assert.equal(events.length, 0);
    });
});
