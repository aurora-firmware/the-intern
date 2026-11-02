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
import type { JobOrigin } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const daemonAuthor = { kind: "daemon" } as const;

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Started = {
    ctx: ServiceContext;
    agents: Awaited<ReturnType<typeof createAgentsComponent>>;
    invoke<T = unknown>(name: string, input: unknown, as?: Caller): Promise<T>;
};

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fake.setResponses([async () => fauxAssistantMessage("done")]);
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
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
        components: [agents.component, jobs.component, probe],
        operations: [...agents.operations, ...jobs.operations],
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
    const ctx = captured as ServiceContext;
    return {
        ctx,
        agents,
        invoke: (name, input, as = webCaller) => daemon.catalogue.invoke(name, input, as) as never,
    };
}

type Listed = { jobs?: unknown[] };
type Got = { worklog?: unknown[] };

const LETTERS = ["C", "W", "E"] as const;
const WAYS_IN = { C: "command line", W: "web interface", E: "email" } as const;
const JOB_COUNT = 10_000;
const WORKLOG_ENTRIES = 1_000;
const LIST_TARGET_MS = 200;
const GET_TARGET_MS = 100;

async function seedJobs(ctx: ServiceContext): Promise<string> {
    let heavyJobId = "";
    for (let i = 0; i < JOB_COUNT; i++) {
        const letter = LETTERS[i % LETTERS.length] as (typeof LETTERS)[number];
        const origin: JobOrigin = { kind: "request", wayIn: WAYS_IN[letter] };
        const { job } = await ctx.jobStore.insertJob({ letter, requestText: "seeded", origin, leadStart: {} });
        if (i % 2 === 0) {
            await ctx.jobStore.applyAction(job.id, "start", {}, daemonAuthor);
            if (i % 4 === 0) {
                await ctx.jobStore.applyAction(job.id, "block", { blockedReason: "waiting" }, daemonAuthor);
            }
        }
        if (i === JOB_COUNT / 2) heavyJobId = job.id;
    }
    for (let i = 0; i < WORKLOG_ENTRIES; i++) {
        await ctx.jobStore.addWorklog(heavyJobId, `note ${i}`, daemonAuthor);
    }
    return heavyJobId;
}

async function timed<T>(label: string, targetMs: number, run: () => Promise<T>): Promise<T> {
    const began = performance.now();
    const result = await run();
    const took = performance.now() - began;
    // The targets are references (S-004 REQ-019): a miss is reported here, never failed.
    console.log(`timing ${label}: ${took.toFixed(1)} ms (reference ${targetMs} ms)`);
    return result;
}

describe("jobs.list and jobs.get reference timings", () => {
    it("reports jobs.list over 10,000 jobs and jobs.get over 1,000 entries beside their references", async () => {
        const started = await start();
        const seedBegan = performance.now();
        const heavyJobId = await seedJobs(started.ctx);
        console.log(`timing seeding: ${(performance.now() - seedBegan).toFixed(0)} ms`);

        const blocked = await timed("jobs.list status filter", LIST_TARGET_MS, () =>
            started.invoke<Listed>("jobs.list", { status: "blocked" }),
        );
        assert.ok((blocked.jobs?.length ?? 0) > 0);
        const lettered = await timed("jobs.list letter filter", LIST_TARGET_MS, () =>
            started.invoke<Listed>("jobs.list", { letter: "E" }),
        );
        assert.ok((lettered.jobs?.length ?? 0) > 0);
        const page = await timed("jobs.list default limit", LIST_TARGET_MS, () =>
            started.invoke<Listed>("jobs.list", {}),
        );
        assert.ok((page.jobs?.length ?? 0) > 0);
        const job = await timed("jobs.get 1,000 worklog entries", GET_TARGET_MS, () =>
            started.invoke<Got>("jobs.get", { job: heavyJobId }),
        );
        assert.ok((job.worklog?.length ?? 0) > 0);
    });
});
