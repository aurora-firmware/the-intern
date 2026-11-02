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

type ListedJob = { number: string; status: string };
type Listed = { jobs: ListedJob[]; cursor?: string };
type Got = ListedJob & { worklog: { text: string }[] };

const LETTERS = ["C", "W", "E"] as const;
const WAYS_IN = { C: "command line", W: "web interface", E: "email" } as const;
const JOB_COUNT = 10_000;
const WORKLOG_ENTRIES = 1_000;
const LIST_TARGET_MS = 200;
const GET_TARGET_MS = 100;
const DEFAULT_PAGE = 50;
const SCAN_PAGE = 500;

// What the seeding makes: job i has letter LETTERS[i % 3]; every even job is started; every fourth is then blocked.
const expectedByLetter = { C: 3334, W: 3333, E: 3333 };
const expectedByStatus = { to_do: 5000, in_progress: 2500, blocked: 2500, done: 0 };

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

// Pages the whole store (untimed) and counts it, so the timings below run over the population AC-019.1 names.
async function assertSeededPopulation(started: Started): Promise<void> {
    const byLetter: Record<string, number> = { C: 0, W: 0, E: 0 };
    const byStatus: Record<string, number> = { to_do: 0, in_progress: 0, blocked: 0, done: 0 };
    const numbers = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await started.invoke<Listed>("jobs.list", { limit: SCAN_PAGE, ...(cursor && { cursor }) });
        for (const job of page.jobs) {
            numbers.add(job.number);
            const letter = job.number.split("-")[0] as string;
            byLetter[letter] = (byLetter[letter] ?? 0) + 1;
            byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
        }
        cursor = page.cursor;
    } while (cursor !== undefined);
    assert.equal(numbers.size, JOB_COUNT);
    assert.deepEqual(byLetter, expectedByLetter);
    assert.deepEqual(byStatus, expectedByStatus);
}

// A filtered query is only measured as such when it returned a full page and nothing outside the filter.
function assertFullPage(listed: Listed, matches: (job: ListedJob) => boolean): void {
    assert.equal(listed.jobs.length, DEFAULT_PAGE);
    assert.ok(listed.cursor !== undefined, "more jobs match than one page holds");
    assert.deepEqual(
        listed.jobs.filter((job) => !matches(job)),
        [],
    );
}

describe("jobs.list and jobs.get reference timings", () => {
    it("reports jobs.list over 10,000 jobs and jobs.get over 1,000 entries beside their references", async () => {
        const started = await start();
        const seedBegan = performance.now();
        const heavyJobId = await seedJobs(started.ctx);
        console.log(`timing seeding: ${(performance.now() - seedBegan).toFixed(0)} ms`);
        await assertSeededPopulation(started);

        const blocked = await timed("jobs.list status filter", LIST_TARGET_MS, () =>
            started.invoke<Listed>("jobs.list", { status: "blocked" }),
        );
        assertFullPage(blocked, (job) => job.status === "blocked");
        const lettered = await timed("jobs.list letter filter", LIST_TARGET_MS, () =>
            started.invoke<Listed>("jobs.list", { letter: "E" }),
        );
        assertFullPage(lettered, (job) => job.number.startsWith("E-"));
        const page = await timed("jobs.list default limit", LIST_TARGET_MS, () =>
            started.invoke<Listed>("jobs.list", {}),
        );
        assertFullPage(page, () => true);
        const job = await timed("jobs.get 1,000 worklog entries", GET_TARGET_MS, () =>
            started.invoke<Got>("jobs.get", { job: heavyJobId }),
        );
        assert.equal(job.worklog.length, WORKLOG_ENTRIES);
        assert.deepEqual(
            job.worklog.map((entry) => entry.text),
            Array.from({ length: WORKLOG_ENTRIES }, (_, i) => `note ${i}`),
        );
    });
});
