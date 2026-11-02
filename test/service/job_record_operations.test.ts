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
import { createSeatedConversation } from "../../src/host/seating.ts";
import type { JobOrigin } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
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

type Entry = {
    at: string;
    author: Record<string, unknown>;
    text?: string;
    field?: string;
    old?: unknown;
    new?: unknown;
};
type JobResult = {
    id: string;
    number: string;
    status: string;
    updatedAt: string;
    title: string;
    definitionOfDone: string;
    related: string[];
    worklog?: Entry[];
    history?: Entry[];
};
type Page<T> = { entries?: T[]; jobs?: T[]; cursor?: string };
type Letter = "C" | "W" | "E";

type Started = {
    ctx: ServiceContext;
    agents: Awaited<ReturnType<typeof createAgentsComponent>>;
    invoke<T = unknown>(name: string, input: unknown, as?: Caller): Promise<T>;
    seed(letter: Letter): Promise<JobResult>;
};

const WAYS_IN: Record<Letter, string> = { C: "command line", W: "web interface", E: "email" };

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
    const jobs = await createJobsComponent({ agents, logger: quietLogger });
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
        async seed(letter) {
            const origin: JobOrigin = { kind: "request", wayIn: WAYS_IN[letter] };
            const { job } = await ctx.jobStore.insertJob({ letter, requestText: "seeded", origin, leadStart: {} });
            return job as unknown as JobResult;
        },
    };
}

async function refusalCode(action: Promise<unknown>): Promise<string> {
    try {
        await action;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
        return error.code;
    }
    throw new Error("expected the operation to be refused");
}

async function seedBlocked(started: Started, letter: Letter): Promise<JobResult> {
    const job = await started.seed(letter);
    await started.ctx.jobStore.applyAction(job.id, "start", {}, daemonAuthor);
    await started.ctx.jobStore.applyAction(job.id, "block", { blockedReason: "waiting" }, daemonAuthor);
    return job;
}

describe("job record operations", () => {
    it("jobs.get returns one job for the number in any case and the ID, and refuses an unknown job", async () => {
        const started = await start();
        await started.seed("C");
        const job = await started.seed("E");
        await started.ctx.jobStore.addWorklog(job.id, "first note", daemonAuthor);
        const lower = await started.invoke<JobResult>("jobs.get", { job: job.number.toLowerCase() });
        const upper = await started.invoke<JobResult>("jobs.get", { job: job.number.toUpperCase() });
        const byId = await started.invoke<JobResult>("jobs.get", { job: job.id });
        assert.deepEqual(lower, upper);
        assert.deepEqual(upper, byId);
        assert.equal(byId.id, job.id);
        assert.deepEqual(
            byId.worklog?.map((entry) => entry.text),
            ["first note"],
        );
        assert.deepEqual(byId.history, []);
        assert.equal(await refusalCode(started.invoke("jobs.get", { job: "E-15" })), "not_found");
    });

    it("jobs.update records old and new value with the author, and refuses fields that are not editable", async () => {
        const started = await start();
        const job = await started.seed("W");
        await started.ctx.jobStore.applyAction(job.id, "start", {}, daemonAuthor);
        const before = await started.invoke<JobResult>("jobs.get", { job: job.number });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const updated = await started.invoke<JobResult>("jobs.update", {
            job: job.number,
            definitionOfDone: "the page loads",
        });
        assert.equal(updated.definitionOfDone, "the page loads");
        assert.notEqual(updated.updatedAt, before.updatedAt);
        const history = await started.invoke<Page<Entry>>("jobs.history.list", { job: job.number });
        const edits = (history.entries ?? []).filter((entry) => entry.field === "definitionOfDone");
        assert.equal(edits.length, 1);
        assert.equal(edits[0]?.old, before.definitionOfDone);
        assert.equal(edits[0]?.new, "the page loads");
        assert.deepEqual(edits[0]?.author, { kind: "team_member", wayIn: "web interface" });
        assert.ok(edits[0]?.at);

        for (const field of ["number", "status", "resolution", "blockedReason", "request", "createdAt"]) {
            const error = await started
                .invoke("jobs.update", { job: job.number, title: "changed", [field]: "x" })
                .catch((caught) => caught);
            assert.ok(error instanceof ServiceError);
            assert.equal(error.code, "invalid_input");
            assert.match(error.message, new RegExp(field));
        }
        const after = await started.invoke<JobResult>("jobs.get", { job: job.number });
        assert.equal(after.title, before.title);
        assert.equal(after.history?.length, history.entries?.length);
    });

    it("jobs.list filters by status and letter and pages newest first over 120 jobs", async () => {
        const started = await start();
        const wanted: string[] = [];
        for (let i = 0; i < 120; i++) {
            if (i % 10 === 0 && wanted.length < 12) wanted.push((await seedBlocked(started, "E")).number);
            else if (i % 4 === 1 && i < 72) await seedBlocked(started, i % 8 === 1 ? "C" : "W");
            else await started.seed(i % 2 === 0 ? "E" : "W");
        }
        const allBlocked = await started.invoke<Page<{ number: string }>>("jobs.list", {
            status: "blocked",
            limit: 100,
        });
        assert.equal(allBlocked.jobs?.length, 30);
        const numbers: string[] = [];
        let pages = 0;
        let cursor: string | undefined;
        do {
            const page: Page<{ number: string; worklog?: unknown; history?: unknown }> = await started.invoke(
                "jobs.list",
                { status: "blocked", letter: "E", limit: 5, ...(cursor && { cursor }) },
            );
            pages++;
            for (const job of page.jobs ?? []) {
                assert.equal("worklog" in job, false);
                assert.equal("history" in job, false);
                numbers.push(job.number);
            }
            cursor = page.cursor;
        } while (cursor !== undefined);
        assert.equal(pages, 3);
        assert.equal(numbers.length, 12);
        assert.deepEqual(numbers, [...wanted].reverse());
        assert.equal(await refusalCode(started.invoke("jobs.list", { status: "paused" })), "invalid_input");
        assert.equal(await refusalCode(started.invoke("jobs.list", { letter: "Z" })), "invalid_input");
        assert.equal(await refusalCode(started.invoke("jobs.list", { limit: 0 })), "invalid_input");
        assert.equal(await refusalCode(started.invoke("jobs.list", { cursor: "garbage" })), "invalid_input");
    });

    it("jobs.relate links both ways, repeats change nothing, and refuses a self link", async () => {
        const started = await start();
        const c = await started.seed("C");
        const w = await started.seed("W");
        const first = await started.invoke<{ a: JobResult; b: JobResult }>("jobs.relate", {
            job: c.number.toLowerCase(),
            other: w.number,
        });
        assert.deepEqual(first.a.related, [w.number]);
        assert.deepEqual(first.b.related, [c.number]);
        const historyLength = async () =>
            (await started.invoke<Page<Entry>>("jobs.history.list", { job: c.number })).entries?.length;
        const length = await historyLength();
        await started.invoke("jobs.relate", { job: c.number, other: w.number });
        assert.equal(await historyLength(), length);
        assert.equal(await refusalCode(started.invoke("jobs.relate", { job: c.number, other: c.id })), "invalid_input");
        const removed = await started.invoke<{ a: JobResult; b: JobResult }>("jobs.unrelate", {
            job: c.number,
            other: w.number,
        });
        assert.deepEqual(removed.a.related, []);
        assert.deepEqual(removed.b.related, []);
    });

    it("jobs.worklog.add returns the entry and the lists page oldest first with a cursor", async () => {
        const started = await start();
        const job = await started.seed("C");
        const entry = await started.invoke<Entry>("jobs.worklog.add", { job: job.number, text: "one" });
        assert.equal(entry.text, "one");
        assert.ok(entry.at);
        assert.deepEqual(entry.author, { kind: "team_member", wayIn: "web interface" });
        await started.invoke("jobs.worklog.add", { job: job.number, text: "two" });
        await started.invoke("jobs.worklog.add", { job: job.number, text: "three" });
        const first = await started.invoke<Page<Entry>>("jobs.worklog.list", { job: job.number, limit: 2 });
        assert.deepEqual(
            first.entries?.map((e) => e.text),
            ["one", "two"],
        );
        assert.ok(first.cursor);
        const second = await started.invoke<Page<Entry>>("jobs.worklog.list", {
            job: job.number,
            limit: 2,
            cursor: first.cursor,
        });
        assert.deepEqual(
            second.entries?.map((e) => e.text),
            ["three"],
        );
        assert.equal(second.cursor, undefined);
        await started.invoke("jobs.update", { job: job.number, title: "a" });
        await started.invoke("jobs.update", { job: job.number, title: "b" });
        const history = await started.invoke<Page<Entry>>("jobs.history.list", { job: job.number, limit: 1 });
        assert.equal(history.entries?.[0]?.new, "a");
        const next = await started.invoke<Page<Entry>>("jobs.history.list", {
            job: job.number,
            limit: 1,
            cursor: history.cursor,
        });
        assert.equal(next.entries?.[0]?.new, "b");
        assert.equal(next.cursor, undefined);
        assert.equal(
            await refusalCode(started.invoke("jobs.worklog.add", { job: job.number, text: "  " })),
            "invalid_input",
        );
        assert.equal(await refusalCode(started.invoke("jobs.worklog.add", { job: "C-99", text: "x" })), "not_found");
    });

    it("an agent caller is authored by its conversation and role, and a job source is refused", async () => {
        const started = await start();
        const job = await started.seed("C");
        const { conversationId } = await createSeatedConversation(started.ctx.host, {
            scope: "test",
            key: "agent",
            job: { jobId: job.id, isLead: true, origin: { kind: "request", wayIn: "command line" }, depth: 0 },
            seat: started.agents.runtime().catalog.seatFor("gp"),
            actor: webCaller.actor as never,
        });
        const agent: Caller = { actor: { kind: "agent", conversationId } };
        const entry = await started.invoke<Entry>("jobs.worklog.add", { job: job.number, text: "from agent" }, agent);
        assert.deepEqual(entry.author, { kind: "agent", conversationId, role: "gp" });
        const source: Caller = { actor: { kind: "job_source", source: "schedule" } };
        const add = started.invoke("jobs.worklog.add", { job: job.number, text: "x" }, source);
        assert.equal(await refusalCode(add), "invalid_input");
        const update = started.invoke("jobs.update", { job: job.number, title: "x" }, source);
        assert.equal(await refusalCode(update), "invalid_input");
    });
});
