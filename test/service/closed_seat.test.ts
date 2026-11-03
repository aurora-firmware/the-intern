/**
 * The seat change of a closed conversation (S-001 REQ-026, REQ-004; S-002 REQ-012; ADR-001 decision 4):
 * `conversations.seat`, with or without a reset, is refused `conflict` with a message naming the conversation as
 * closed and writes no seat, no seat record and no reset entry. An open conversation is reseated as before.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { HostEntry } from "../../src/host/harness_host.ts";
import { abortJobConversations } from "../../src/host/invocation.ts";
import {
    createSeatedConversation,
    readConversationMeta,
    SEAT_RECORD_KIND,
    type SeatActor,
} from "../../src/host/seating.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const caller: Caller = { actor: { kind: "team_member", wayIn: "cli" } };
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
    fake.setResponses([() => fauxAssistantMessage("ok")]);
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
    return {
        host,
        seatConversation,
        entries,
        seatOperation: (input: unknown) => daemon.catalogue.invoke("conversations.seat", input, caller),
        createReviewer: () =>
            daemon.catalogue.invoke(
                "roles.create",
                { name: "reviewer", instructions: "Review.", tools: ["read"], model: `${provider}/model-one` },
                caller,
            ),
    };
}

async function conflictMessage(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
        assert.equal(error.code, "conflict");
        return error.message;
    }
    return assert.fail("expected the call to reject");
}

describe("conversations.seat of a closed conversation", () => {
    for (const [name, extra] of [
        ["a seat change", {}],
        ["a seat change with a reset", { reset: { note: "again" } }],
    ] as const) {
        it(`refuses ${name} conflict naming the conversation as closed and writes nothing`, async () => {
            const started = await start();
            await started.createReviewer();
            const id = await started.seatConversation("job-1");
            await abortJobConversations(started.host, "job-1");
            const entriesBefore = await started.entries(id);
            const seatBefore = (await readConversationMeta(started.host, id))?.seat;

            const message = await conflictMessage(
                started.seatOperation({ conversationId: id, role: "reviewer", ...extra }),
            );

            assert.match(message, new RegExp(`"${id}" is closed`));
            assert.deepEqual((await readConversationMeta(started.host, id))?.seat, seatBefore);
            assert.equal((await started.entries(id)).length, entriesBefore.length);
        });
    }

    it("still refuses a role that does not resolve with the code it had", async () => {
        const started = await start();
        const id = await started.seatConversation("job-1");
        await abortJobConversations(started.host, "job-1");

        try {
            await started.seatOperation({ conversationId: id, role: "no-such-role" });
            assert.fail("expected the call to reject");
        } catch (error) {
            assert.ok(error instanceof ServiceError);
            assert.equal(error.code, "not_found");
        }
    });
});

describe("conversations.seat of an open conversation", () => {
    it("changes the seat of a conversation of a job and records it", async () => {
        const started = await start();
        await started.createReviewer();
        const id = await started.seatConversation("job-1");

        await started.seatOperation({ conversationId: id, role: "reviewer" });

        assert.equal((await readConversationMeta(started.host, id))?.seat.role, "reviewer");
        assert.equal((await started.entries(id)).filter((entry) => entry.kind === SEAT_RECORD_KIND).length, 2);
    });

    it("changes the seat of a conversation of a job with a reset", async () => {
        const started = await start();
        await started.createReviewer();
        const id = await started.seatConversation("job-1");

        await started.seatOperation({ conversationId: id, role: "reviewer", reset: {} });

        assert.equal((await readConversationMeta(started.host, id))?.seat.role, "reviewer");
        assert.equal((await started.entries(id)).filter((entry) => entry.kind === "pi.reset").length, 1);
    });

    it("changes the seat of the front desk to a role it allows", async () => {
        const started = await start();
        await started.createReviewer();
        const id = await started.seatConversation(null);

        await started.seatOperation({ conversationId: id, role: "reviewer" });

        assert.equal((await readConversationMeta(started.host, id))?.seat.role, "reviewer");
    });
});
