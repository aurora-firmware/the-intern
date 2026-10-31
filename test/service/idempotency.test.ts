import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { createConversationOnce, HostInvalidKeyError } from "../../src/host/idempotency.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type FakeModel = ReturnType<typeof createFakeModel>;

const MAX_KEY_LENGTH = 200;
const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
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

type Fixture = { env: HermeticEnv; fake: FakeModel; agent: { model: string }; open(): Promise<HarnessHost> };

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const agent = { model: `${fake.getModel().provider}/${fake.getModel().id}` };
    const open = async (): Promise<HarnessHost> => {
        const host = await openHarnessHost({
            databaseFile: join(env.root, "state.sqlite"),
            models: modelsFor(fake),
            harnessSettings: {},
            extensions: [],
            defaultCwd: process.cwd(),
            logger: createLogger({ stream: { write: () => true } }),
        });
        hosts.push(host);
        return host;
    };
    return { env, fake, agent, open };
}

describe("createConversationOnce", () => {
    it("creates one conversation and returns its id both times when a key is repeated", async () => {
        const { open, agent } = await createFixture();
        const host = await open();

        const first = await createConversationOnce(host, { scope: "start-job", key: "k1", agent });
        const second = await createConversationOnce(host, { scope: "start-job", key: "k1", agent });

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(second.conversationId, first.conversationId);
        assert.equal((await host.listConversations()).length, 1);
    });

    it("creates one conversation when two calls with the same key run concurrently", async () => {
        const { open, agent } = await createFixture();
        const host = await open();

        const results = await Promise.all([
            createConversationOnce(host, { scope: "start-job", key: "k1", agent }),
            createConversationOnce(host, { scope: "start-job", key: "k1", agent }),
        ]);

        assert.equal(results[0].conversationId, results[1].conversationId);
        assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
        assert.equal((await host.listConversations()).length, 1);
    });

    it("creates one conversation per scope when the same key is used under two scopes", async () => {
        const { open, agent } = await createFixture();
        const host = await open();

        const first = await createConversationOnce(host, { scope: "start-job", key: "k1", agent });
        const second = await createConversationOnce(host, { scope: "other-operation", key: "k1", agent });

        assert.notEqual(second.conversationId, first.conversationId);
        assert.equal(second.created, true);
        assert.equal((await host.listConversations()).length, 2);
    });

    it("returns the original conversation after the host is closed and opened again", async () => {
        const { open, agent } = await createFixture();
        const firstHost = await open();
        const first = await createConversationOnce(firstHost, { scope: "start-job", key: "k1", agent });
        await firstHost.close();

        const secondHost = await open();
        const again = await createConversationOnce(secondHost, { scope: "start-job", key: "k1", agent });

        assert.equal(again.created, false);
        assert.equal(again.conversationId, first.conversationId);
        assert.equal((await secondHost.listConversations()).length, 1);
    });

    for (const [name, key] of [
        ["empty", ""],
        ["longer than 200 characters", "x".repeat(MAX_KEY_LENGTH + 1)],
    ] as const) {
        it(`throws HostInvalidKeyError and creates nothing when the key is ${name}`, async () => {
            const { open, agent } = await createFixture();
            const host = await open();

            await assert.rejects(createConversationOnce(host, { scope: "start-job", key, agent }), HostInvalidKeyError);

            assert.equal((await host.listConversations()).length, 0);
        });
    }

    it("accepts a key of exactly 200 characters", async () => {
        const { open, agent } = await createFixture();
        const host = await open();

        const result = await createConversationOnce(host, {
            scope: "start-job",
            key: "x".repeat(MAX_KEY_LENGTH),
            agent,
        });

        assert.equal(result.created, true);
    });
});
