import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HostDatabase, type HostSqlExecutor, openHostDatabase } from "../../src/host/harness_host.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { JOB_TOOL_NAMES } from "../../src/jobs/job_model.ts";
import { createJobStore, JobNotFoundError, JobRefusedError, migrateJobStore } from "../../src/jobs/job_store.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const SCRIPT_INPUT = "script";
const WRITE_REFUSED = "job store write refused";
const WRITE_FAILED_LOG = "job store write failed; the daemon exits";
const cliCaller = { actor: { kind: "team_member", wayIn: "command line" } } as const;
const JOB_TOOLS = [...JOB_TOOL_NAMES];

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const databases: { close(): Promise<void> }[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS + 1_000)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const database of databases.splice(0)) await database.close();
    for (const env of envs.splice(0)) await env.dispose();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Makes the statements the predicate names fail, in whatever transaction they run; the earlier ones roll back. */
type FailureSwitch = { shouldFail: (sql: string) => boolean };

function failingExecutor(tx: HostSqlExecutor, failure: FailureSwitch): HostSqlExecutor {
    return {
        exec: (sql) => tx.exec(sql),
        run: (sql, ...params) =>
            failure.shouldFail(sql) ? Promise.reject(new Error(WRITE_REFUSED)) : tx.run(sql, ...params),
        get: (sql, ...params) => tx.get(sql, ...params),
        all: (sql, ...params) => tx.all(sql, ...params),
    };
}

function failingDatabase(db: HostDatabase, failure: FailureSwitch): HostDatabase {
    return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...params) => db.run(sql, ...params),
        get: (sql, ...params) => db.get(sql, ...params),
        all: (sql, ...params) => db.all(sql, ...params),
        transaction: (callback) => db.transaction((tx) => callback(failingExecutor(tx, failure))),
    };
}

const isNoWrite = () => false;
const isHistoryWrite = (sql: string) => sql.startsWith("INSERT INTO intern_history");
const isStartWrite = (sql: string) => sql.startsWith("UPDATE intern_jobs SET status");
const newJob = (requestText: string) => ({
    letter: "A" as const,
    requestText,
    origin: { kind: "request", wayIn: "command line" } as const,
    leadStart: {},
});

describe("the job store reports a failed write", () => {
    async function openStore(failure: FailureSwitch, onWriteFailure: (error: unknown) => void) {
        const env = await createHermeticEnv();
        envs.push(env);
        const db = await openHostDatabase(join(env.dataDir, "bob.sqlite"));
        databases.push(db);
        await migrateJobStore(db);
        const store = createJobStore(failingDatabase(db, failure), { onWriteFailure });
        const { job } = await store.insertJob(newJob("renew the certificate"));
        return { store, job };
    }

    it("rejects with the error, rolls the write back and calls onWriteFailure once", async () => {
        const failure: FailureSwitch = { shouldFail: isNoWrite };
        const reported: unknown[] = [];
        const { store, job } = await openStore(failure, (error) => reported.push(error));
        const historyBefore = (await store.listHistory(job.id, {})).entries.length;
        failure.shouldFail = isHistoryWrite;

        await assert.rejects(
            store.updateFields(job.id, { title: "Renew" }, { kind: "daemon" }),
            (error: unknown) => error instanceof Error && error.message === WRITE_REFUSED,
        );

        assert.equal(reported.length, 1);
        assert.equal((reported[0] as Error).message, WRITE_REFUSED);
        assert.equal((await store.getJob(job.id)).title, job.title);
        assert.equal((await store.listHistory(job.id, {})).entries.length, historyBefore);
    });

    it("reports a failed insert, a failed action and a failed repair record too", async () => {
        const failure: FailureSwitch = { shouldFail: isNoWrite };
        const reported: unknown[] = [];
        const { store, job } = await openStore(failure, (error) => reported.push(error));
        failure.shouldFail = () => true;

        await assert.rejects(store.insertJob(newJob("another")));
        assert.equal(reported.length, 1);
        await assert.rejects(store.applyAction(job.id, "start", {}, { kind: "daemon" }));
        assert.equal(reported.length, 2);
        await assert.rejects(store.recordRepair(job.id, { rule: 1, did: "x" }));
        assert.equal(reported.length, 3);
    });

    it("does not report a refused write or an unknown job", async () => {
        const failure: FailureSwitch = { shouldFail: isNoWrite };
        const reported: unknown[] = [];
        const { store, job } = await openStore(failure, (error) => reported.push(error));

        await assert.rejects(store.addWorklog(job.id, "", { kind: "daemon" }), JobRefusedError);
        await assert.rejects(store.addWorklog("A-999", "note", { kind: "daemon" }), JobNotFoundError);

        assert.deepEqual(reported, []);
    });
});

type Call = { name: string; arguments: Record<string, unknown> };
type ModelContext = Parameters<FauxResponseFactory>[0];

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

const isScripted = (context: ModelContext): boolean =>
    context.messages.some((message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT);

type StartOptions = { components?: DaemonComponent[]; failure?: FailureSwitch };

async function start(options: StartOptions = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const lines: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (chunk) => lines.push(String(chunk)) } });
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    let script: Call[] = [];
    let step = 0;
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        if (!isScripted(context)) return fauxAssistantMessage("done");
        const call = script[step];
        step += 1;
        if (call === undefined) return fauxAssistantMessage("finished");
        return fauxAssistantMessage([fauxToolCall(call.name, call.arguments as never)], { stopReason: "toolUse" });
    };
    fake.setResponses([respond]);
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const failure = options.failure ?? { shouldFail: isNoWrite };
    let wrapped = 0;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: agents.sections,
        components: [agents.component, jobs.component, probe, ...(options.components ?? [])],
        operations: [...agents.operations, ...jobs.operations],
        wrapJobDatabase: (database) => {
            wrapped += 1;
            return failingDatabase(database, failure);
        },
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
    const host = () => (captured as ServiceContext).host;
    return {
        daemon,
        env,
        failure,
        lines,
        wrapCount: () => wrapped,
        ctx: () => captured as ServiceContext,
        async ready() {
            const deadline = Date.now() + WAIT_MS;
            while (daemon.phase() !== "ready") {
                if (Date.now() > deadline) throw new Error("the daemon did not become ready");
                await sleep(POLL_MS);
            }
        },
        async seat(jobId: string): Promise<string> {
            const seat = { ...agents.runtime().catalog.seatFor("gp"), tools: JOB_TOOLS };
            const { conversationId } = await createSeatedConversation(host(), {
                scope: "job-store-failure-test",
                key: jobId,
                job: { jobId, isLead: true, origin: { kind: "request", wayIn: "command line" }, depth: 0 },
                seat,
                actor: cliCaller.actor,
            });
            return conversationId;
        },
        async run(conversationId: string, calls: Call[]): Promise<void> {
            script = calls;
            step = 0;
            const submission = await submitInput(host(), conversationId, {
                content: SCRIPT_INPUT,
                requestId: "script-1",
                busyMode: "reject",
            });
            await waitForSubmission(host(), submission.submissionId, WAIT_MS).catch(() => undefined);
        },
    };
}

async function exitedWithin(daemon: RunningDaemon, since: number): Promise<number> {
    const status = await Promise.race([
        daemon.exited,
        sleep(STOP_BOUND_MS + 1_000).then(() => Promise.reject(new Error("the daemon did not exit"))),
    ]);
    assert.ok(Date.now() - since <= STOP_BOUND_MS, "the daemon exited within the stop bound");
    return status;
}

const logged = (lines: string[], text: string): string[] => lines.filter((line) => line.includes(text));

type Created = { id: string; title: string };

describe("a failed job store write in the daemon", () => {
    it("fails the operation internal, leaves the job unchanged, logs, refuses calls and exits non-zero", async () => {
        const started = await start();
        await started.ready();
        const job = (await started.daemon.catalogue.invoke("jobs.create", { text: "renew" }, cliCaller)) as Created;
        const before = (await started.ctx().jobStore.listHistory(job.id, {})).entries.length;
        started.failure.shouldFail = isHistoryWrite;
        const since = Date.now();

        await assert.rejects(
            started.daemon.catalogue.invoke("jobs.update", { job: job.id, title: "Renew" }, cliCaller),
            (error: unknown) => error instanceof ServiceError && error.code === "internal",
        );

        assert.notEqual(await exitedWithin(started.daemon, since), 0);
        assert.equal(logged(started.lines, WRITE_FAILED_LOG).length, 1);
        assert.match(logged(started.lines, WRITE_FAILED_LOG)[0] ?? "", new RegExp(WRITE_REFUSED));
        assert.equal(started.wrapCount(), 1, "the database is not reopened");
        await assert.rejects(
            started.daemon.catalogue.invoke("jobs.list", {}, cliCaller),
            (error: unknown) => error instanceof ServiceError && error.code === "unavailable",
        );
        const reopened = await openHostDatabase(started.ctx().dirs.databaseFile, { readOnly: true });
        databases.push(reopened);
        const store = createJobStore(reopened);
        assert.equal((await store.getJob(job.id)).title, job.title);
        assert.equal((await store.listHistory(job.id, {})).entries.length, before);
    });

    it("exits the same way when the write fails inside a job tool call", async () => {
        const started = await start();
        await started.ready();
        const job = (await started.daemon.catalogue.invoke("jobs.create", { text: "renew" }, cliCaller)) as Created;
        const conversation = await started.seat(job.id);
        started.failure.shouldFail = isHistoryWrite;
        const since = Date.now();

        await started.run(conversation, [{ name: "update_job", arguments: { title: "Renew" } }]);

        assert.notEqual(await exitedWithin(started.daemon, since), 0);
        assert.equal(logged(started.lines, WRITE_FAILED_LOG).length, 1);
        assert.equal(started.wrapCount(), 1);
    });

    it("exits the same way when the start write fails in a listener before the lead's first request", async () => {
        const started = await start();
        await started.ready();
        started.failure.shouldFail = isStartWrite;
        const since = Date.now();

        await started.daemon.catalogue.invoke("jobs.create", { text: "renew" }, cliCaller).catch(() => undefined);

        assert.notEqual(await exitedWithin(started.daemon, since), 0);
        assert.equal(logged(started.lines, WRITE_FAILED_LOG).length, 1);
        assert.equal(started.wrapCount(), 1);
    });

    it("exits non-zero without becoming ready when a write fails during startup and the caller swallows it", async () => {
        const failure: FailureSwitch = { shouldFail: isNoWrite };
        const swallow: DaemonComponent = {
            name: "swallow",
            async repair(ctx) {
                failure.shouldFail = () => true;
                await ctx.jobStore.insertJob(newJob("during startup")).catch(() => undefined);
                failure.shouldFail = isNoWrite;
            },
        };
        const started = await start({ components: [swallow], failure });
        const since = Date.now();

        assert.notEqual(await exitedWithin(started.daemon, since), 0);
        assert.notEqual(started.daemon.phase(), "ready");
    });
});
