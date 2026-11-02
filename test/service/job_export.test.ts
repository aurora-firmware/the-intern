import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { backupDatabase } from "../../src/host/database_copy.ts";
import { type HostDatabase, hostDatabase, openHostDatabase } from "../../src/host/harness_host.ts";
import { steerConversation } from "../../src/host/steering.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const OWNER_ONLY = 0o600;
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

type CreatedJob = { id: string; number: string; leadConversation: string };
type Started = {
    env: HermeticEnv;
    ctx: ServiceContext;
    /** Holds every model call from now on until `release` is called. */
    hold(): { release(): void; started: Promise<void> };
    create(): Promise<CreatedJob>;
    invoke<T = unknown>(name: string, input: unknown): Promise<T>;
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let gate: { open: Promise<void>; entered(): void } | undefined;
    const answer = async () => {
        fake.appendResponses([answer]);
        if (gate) {
            gate.entered();
            await gate.open;
        }
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
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
    await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
    const ctx = captured as ServiceContext;
    const invoke = <T>(name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller) as Promise<T>;
    return {
        env,
        ctx,
        hold() {
            const entered = Promise.withResolvers<void>();
            const open = Promise.withResolvers<void>();
            gate = { open: open.promise, entered: entered.resolve };
            return {
                release() {
                    gate = undefined;
                    open.resolve();
                },
                started: entered.promise,
            };
        },
        async create() {
            const job = await invoke<CreatedJob>("jobs.create", { text: "do it" });
            await waitFor(async () => (await ctx.host.conversationInfo(job.leadConversation))?.busy === false, "idle");
            return job;
        },
        invoke,
    };
}

async function rowCounts(database: HostDatabase): Promise<Record<string, number>> {
    const tables = await database.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
        const row = await database.get<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`);
        counts[name] = row?.n ?? 0;
    }
    return counts;
}

async function namesStarting(directory: string, prefix: string): Promise<string[]> {
    return (await readdir(directory)).filter((name) => name.startsWith(prefix));
}

async function assertInvalidPath(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof ServiceError);
        assert.equal(error.code, "invalid_input");
        assert.match(error.message, /\bpath\b/);
        return true;
    });
}

describe("jobs.export", () => {
    it("copies the whole database owner-only while a run goes on", async () => {
        const started = await start();
        const first = await started.create();
        await started.create();
        await started.invoke("jobs.worklog.add", { job: first.id, text: "a note" });
        const target = join(started.env.root, "backup.sqlite");
        const held = started.hold();
        await steerConversation(started.ctx.host, first.leadConversation, {
            content: "carry on",
            mode: "followUp",
            actor: { kind: "team_member", wayIn: "web interface" },
            requestId: "export-test-1",
        });
        await held.started;
        assert.equal((await started.ctx.host.conversationInfo(first.leadConversation))?.busy, true);
        const before = await rowCounts(hostDatabase(started.ctx.host));

        const result = await started.invoke<{ path: string; size: number }>("jobs.export", { path: target });

        assert.equal(result.path, target);
        assert.equal(result.size, (await stat(target)).size);
        assert.equal((await stat(target)).mode & 0o777, OWNER_ONLY);
        assert.deepEqual(await namesStarting(started.env.root, "backup"), ["backup.sqlite"]);
        held.release();
        await waitFor(
            async () => (await started.ctx.host.conversationInfo(first.leadConversation))?.busy === false,
            "the held run to finish",
        );
        const copy = await openHostDatabase(target);
        const after = await rowCounts(copy);
        await copy.close();
        assert.deepEqual(Object.keys(after), Object.keys(before));
        for (const [table, count] of Object.entries(before)) {
            assert.ok((after[table] ?? 0) >= count, `${table} has ${after[table]} rows, expected at least ${count}`);
        }
        assert.equal(after.intern_jobs, 2);
        assert.ok((after.intern_worklog ?? 0) >= 1);
        assert.ok((after.intern_history ?? 0) >= 2);
    });

    it("waits for a transaction in progress and copies nothing it didn't commit", async () => {
        const started = await start();
        const database = hostDatabase(started.ctx.host);
        await database.exec("CREATE TABLE intern_probe (name TEXT NOT NULL)");
        const finish = Promise.withResolvers<void>();
        const transaction = database.transaction(async (tx) => {
            await tx.run("INSERT INTO intern_probe (name) VALUES (?)", "never committed");
            await finish.promise;
            throw new Error("roll back");
        });
        transaction.catch(() => {});
        const target = join(started.env.root, "waited.sqlite");
        const exporting = started.invoke<{ size: number }>("jobs.export", { path: target });
        await new Promise((resolve) => setTimeout(resolve, 150));
        await assert.rejects(stat(target), { code: "ENOENT" });
        finish.resolve();
        await assert.rejects(transaction, /roll back/);

        const result = await exporting;

        assert.equal(result.size, (await stat(target)).size);
        const copy = await openHostDatabase(target);
        assert.deepEqual(await copy.all("SELECT name FROM intern_probe"), []);
        await copy.close();
        assert.deepEqual(await namesStarting(started.env.root, ".waited"), []);
    });

    it("gives up with an error and leaves nothing behind when a transaction outlasts the attempts", async () => {
        const started = await start();
        const finish = Promise.withResolvers<void>();
        const transaction = hostDatabase(started.ctx.host).transaction(() => finish.promise);
        const target = join(started.env.root, "gave_up.sqlite");

        await assert.rejects(backupDatabase(started.ctx.host, target, { attempts: 3, retryDelayMs: 1 }), /transaction/);

        finish.resolve();
        await transaction;
        assert.deepEqual(await namesStarting(started.env.root, "gave_up"), []);
        assert.deepEqual(await namesStarting(started.env.root, ".gave_up"), []);
    });

    it("refuses a relative path, naming path, and writes nothing", async () => {
        const started = await start();
        await assertInvalidPath(started.invoke("jobs.export", { path: "export_relative.sqlite" }));
        assert.deepEqual(await namesStarting(process.cwd(), "export_relative"), []);
    });

    it("refuses an existing file, naming path, and leaves it as it was", async () => {
        const started = await start();
        const target = join(started.env.root, "taken.sqlite");
        await writeFile(target, "keep me");
        await assertInvalidPath(started.invoke("jobs.export", { path: target }));
        assert.equal((await stat(target)).size, "keep me".length);
        assert.deepEqual(await namesStarting(started.env.root, "taken"), ["taken.sqlite"]);
    });

    it("refuses a path whose folder doesn't exist, naming path", async () => {
        const started = await start();
        const target = join(started.env.root, "absent", "backup.sqlite");
        await assertInvalidPath(started.invoke("jobs.export", { path: target }));
        assert.deepEqual(await namesStarting(started.env.root, "absent"), []);
    });
});
