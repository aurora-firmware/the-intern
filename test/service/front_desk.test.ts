import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { FRONT_DESK_CREATION } from "../../src/desk/desk_model.ts";
import { findCreatedConversation } from "../../src/host/idempotency.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Instance = {
    start(): Promise<RunningDaemon>;
    context(): ServiceContext;
    /** Leaves the pi agent folder with no default model, as if the team member had removed it. */
    removeDefaultModel(): Promise<void>;
};

async function createInstance(): Promise<Instance> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    fake.setResponses([() => fauxAssistantMessage("done")]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    let captured: ServiceContext | undefined;
    return {
        removeDefaultModel: () => writeFile(join(env.piAgentDir, "settings.json"), "{}"),
        context() {
            if (captured === undefined) throw new Error("the daemon has not started");
            return captured;
        },
        async start() {
            const agents = await createAgentsComponent({ logger: quietLogger });
            const jobs = await createJobsComponent({ agents, logger: quietLogger });
            const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
            const daemon = runDaemon({
                flags: {
                    configDir: env.configDir,
                    stateDir: env.stateDir,
                    dataDir: env.dataDir,
                    runtimeDir: env.runtimeDir,
                },
                env: env.env,
                homeDir: env.root,
                logger: quietLogger,
                sections: agents.sections,
                components: [
                    agents.component,
                    jobs.component,
                    desk.component,
                    {
                        name: "capture",
                        start: async (ctx) => {
                            captured = ctx;
                        },
                    },
                ],
                operations: [...agents.operations, ...jobs.operations, ...desk.operations],
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
                if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to become ready");
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
            return daemon;
        },
    };
}

type DeskView = { conversationId: string; seat: { role: string; model: string; workspace: string } };
type Listing = {
    id: string;
    jobId: string | null;
    isLead: boolean;
    isFrontDesk: boolean;
    origin: { kind: string } | null;
    seat: unknown;
};

const deskOf = async (daemon: RunningDaemon) => (await daemon.catalogue.invoke("desk.get", {}, webCaller)) as DeskView;
const listAll = async (daemon: RunningDaemon) =>
    (await daemon.catalogue.invoke("conversations.list", {}, webCaller)) as Listing[];
const entriesOf = (daemon: RunningDaemon, conversationId: string) =>
    daemon.catalogue.invoke("conversations.entries", { conversationId }, webCaller);

describe("the front desk", () => {
    it("is created on a new instance seated as desk with no job, no lead flag and the front_desk origin", async () => {
        const daemon = await (await createInstance()).start();

        const desk = await deskOf(daemon);

        const all = await listAll(daemon);
        assert.equal(all.length, 1);
        assert.equal(all[0]?.id, desk.conversationId);
        assert.equal(all[0]?.jobId, null);
        assert.equal(all[0]?.isLead, false);
        assert.deepEqual(all[0]?.origin, { kind: "front_desk" });
        assert.equal(desk.seat.role, "desk");
        const entries = (await entriesOf(daemon, desk.conversationId)) as { entries: { kind: string }[] };
        assert.deepEqual(
            entries.entries.map((entry) => entry.kind),
            ["intern.seat"],
        );
    });

    it("keeps its id, seat and entries and creates no second front desk when the daemon restarts", async () => {
        const instance = await createInstance();
        const first = await instance.start();
        const before = await deskOf(first);
        const entriesBefore = await entriesOf(first, before.conversationId);
        assert.equal(await first.stop(), 0);

        const second = await instance.start();

        assert.deepEqual(await deskOf(second), before);
        assert.deepEqual(await entriesOf(second, before.conversationId), entriesBefore);
        assert.equal((await listAll(second)).length, 1);
    });

    it("restarts with its id and entries when the pi agent folder no longer names a model", async () => {
        const instance = await createInstance();
        const first = await instance.start();
        const before = await deskOf(first);
        const entriesBefore = await entriesOf(first, before.conversationId);
        assert.equal(await first.stop(), 0);
        await instance.removeDefaultModel();

        const second = await instance.start();

        assert.deepEqual(await deskOf(second), before);
        assert.deepEqual(await entriesOf(second, before.conversationId), entriesBefore);
        assert.equal((await listAll(second)).length, 1);
    });

    it("returns from desk.get the seat that conversations.get returns for that id", async () => {
        const daemon = await (await createInstance()).start();

        const desk = await deskOf(daemon);

        const listing = (await daemon.catalogue.invoke(
            "conversations.get",
            { conversationId: desk.conversationId },
            webCaller,
        )) as Listing;
        assert.deepEqual(desk.seat, listing.seat);
    });

    it("records the front desk's id under the fixed creation key", async () => {
        const instance = await createInstance();
        const daemon = await instance.start();

        const desk = await deskOf(daemon);

        assert.equal(await findCreatedConversation(instance.context().host, FRONT_DESK_CREATION), desk.conversationId);
    });

    it("marks the front desk with isFrontDesk and no other conversation", async () => {
        const daemon = await (await createInstance()).start();
        const desk = await deskOf(daemon);
        await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller);

        const all = await listAll(daemon);

        assert.ok(all.length >= 2);
        assert.deepEqual(
            all.filter((listing) => listing.isFrontDesk).map((listing) => listing.id),
            [desk.conversationId],
        );
        const listed = all.find((listing) => listing.id === desk.conversationId);
        assert.equal(listed?.jobId, null);
        assert.equal(listed?.isLead, false);
        assert.deepEqual(listed?.origin, { kind: "front_desk" });
    });

    it("leaves the front desk out when listing the conversations of a job", async () => {
        const daemon = await (await createInstance()).start();
        const desk = await deskOf(daemon);
        const job = (await daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as { id: string };

        const listed = (await daemon.catalogue.invoke("conversations.list", { jobId: job.id }, webCaller)) as Listing[];

        assert.ok(listed.length >= 1);
        assert.ok(listed.every((listing) => listing.id !== desk.conversationId && !listing.isFrontDesk));
    });

    it("returns from conversations.get the front_desk origin, no job and the front desk mark", async () => {
        const daemon = await (await createInstance()).start();
        const desk = await deskOf(daemon);

        const listing = (await daemon.catalogue.invoke(
            "conversations.get",
            { conversationId: desk.conversationId },
            webCaller,
        )) as Listing;

        assert.deepEqual(listing.origin, { kind: "front_desk" });
        assert.equal(listing.jobId, null);
        assert.equal(listing.isFrontDesk, true);
    });
});
