/**
 * A job the front desk creates (S-004 REQ-002, REQ-003, REQ-021): a request over the way in of the input the front desk
 * answers, with the front desk in its origin details, no Related job, and the front desk's agent as the lead's seat actor.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { readConversationMeta, SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const TEST_TIMEOUT_MS = 60_000;
const quietLogger = createLogger({ stream: { write: () => true } });
const commandLine: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    let hostContext: { host: Parameters<typeof readConversationMeta>[0] } | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [
            agents.component,
            jobs.component,
            desk.component,
            {
                name: "capture-host",
                start: async (ctx) => {
                    hostContext = ctx;
                },
                stop: async () => {},
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations],
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation, "the fake model's api is registered");
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
    const invoke = (name: string, input: unknown, caller: Caller = commandLine) =>
        daemon.catalogue.invoke(name, input, caller);
    const deskId = ((await invoke("desk.get", {})) as { conversationId: string }).conversationId;
    const asDesk = (wayIn: string): Caller => ({ actor: { kind: "front_desk", conversationId: deskId, wayIn } });
    const host = hostContext?.host;
    assert.ok(host, "the host is captured");
    return { invoke, deskId, asDesk, host };
}

type JobResult = {
    id: string;
    number: string;
    request: { origin: unknown };
    relatedTo?: unknown;
    related?: unknown[];
    leadConversation: string;
};

describe("a job the front desk creates", { timeout: TEST_TIMEOUT_MS }, () => {
    it("records a command line request naming the front desk, related to no job, with its lead seated as bob", async () => {
        const fixture = await start();

        const job = (await fixture.invoke(
            "jobs.create",
            { text: "do it" },
            fixture.asDesk("command line"),
        )) as JobResult;

        assert.match(job.number, /^C-[1-9][0-9]*$/);
        assert.deepEqual(job.request.origin, { kind: "request", wayIn: "command line", frontDesk: fixture.deskId });
        assert.deepEqual(job.related ?? [], []);
        const meta = await readConversationMeta(fixture.host, job.leadConversation);
        assert.equal(meta?.seat.role, "bob");
    });

    it("numbers a web interface request with W and names the front desk in its origin", async () => {
        const fixture = await start();

        const job = (await fixture.invoke(
            "jobs.create",
            { text: "do it" },
            fixture.asDesk("web interface"),
        )) as JobResult;

        assert.match(job.number, /^W-[1-9][0-9]*$/);
        assert.deepEqual(job.request.origin, { kind: "request", wayIn: "web interface", frontDesk: fixture.deskId });
    });

    it("refuses a way in with no letter as invalid input and uses no number", async () => {
        const fixture = await start();

        await assert.rejects(
            fixture.invoke("jobs.create", { text: "do it" }, fixture.asDesk("telepathy")),
            (error) => error instanceof ServiceError && error.code === "invalid_input",
        );

        const job = (await fixture.invoke(
            "jobs.create",
            { text: "next" },
            fixture.asDesk("command line"),
        )) as JobResult;
        assert.equal(job.number, "C-1");
        assert.equal(((await fixture.invoke("jobs.list", {})) as { jobs: unknown[] }).jobs.length, 1);
    });

    it("seats the lead with the front desk's agent, its conversation and the role desk, as the actor", async () => {
        const fixture = await start();

        const job = (await fixture.invoke(
            "jobs.create",
            { text: "do it" },
            fixture.asDesk("command line"),
        )) as JobResult;

        const page = (await fixture.invoke("conversations.entries", {
            conversationId: job.leadConversation,
            limit: 100,
        })) as { entries: { kind: string; data: { actor: unknown } }[] };
        const seatRecords = page.entries.filter((entry) => entry.kind === SEAT_RECORD_KIND);
        assert.deepEqual(seatRecords[0]?.data.actor, { kind: "agent", conversationId: fixture.deskId, role: "desk" });
    });
});
