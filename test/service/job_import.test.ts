import assert from "node:assert/strict";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { OwnershipRefusedError } from "../../src/daemon/ownership.ts";
import { ImportRefusedError, importDatabase } from "../../src/host/database_import.ts";
import { JOB_SCHEMA_VERSION } from "../../src/jobs/job_store.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const OWNER_ONLY = 0o600;
const DATABASE_NAME = "the-intern.sqlite";
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

type Job = { id: string; number: string; leadConversation: string; related?: string[] };
type Instance = {
    env: HermeticEnv;
    daemon: RunningDaemon;
    invoke<T = unknown>(name: string, input: unknown): Promise<T>;
    stop(): Promise<void>;
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function newEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

async function startInstance(env: HermeticEnv): Promise<Instance> {
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const answer = async () => {
        fake.appendResponses([answer]);
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
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, jobs.component],
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
    return {
        env,
        daemon,
        invoke: <T>(name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller) as Promise<T>,
        stop: async () => {
            await daemon.stop();
            daemons.splice(daemons.indexOf(daemon), 1);
        },
    };
}

/** An instance with two jobs, a worklog entry and a Related link, exported to a file and stopped. */
async function exportedFile(): Promise<{ file: string; jobs: Job[]; leadEntries: number }> {
    const source = await startInstance(await newEnv());
    const first = await source.invoke<Job>("jobs.create", { text: "first" });
    const second = await source.invoke<Job>("jobs.create", { text: "second" });
    await source.invoke("jobs.worklog.add", { job: first.id, text: "a note" });
    await source.invoke("jobs.relate", { job: first.number, other: second.number });
    for (const job of [first, second]) {
        await waitFor(async () => {
            const info = await source.invoke<{ status: string }>("conversations.get", {
                conversationId: job.leadConversation,
            });
            return info.status === "idle";
        }, "the lead to be idle");
    }
    const file = join(source.env.root, "export.sqlite");
    const leadEntries = await entryCount(source, first.leadConversation);
    await source.invoke("jobs.export", { path: file });
    await source.stop();
    return { file, jobs: [first, second], leadEntries };
}

async function entryCount(instance: Instance, conversationId: string): Promise<number> {
    const page = await instance.invoke<{ entries: unknown[] }>("conversations.entries", { conversationId });
    return page.entries.length;
}

/** A minimal file that carries only the two schema version tables. */
function versionOnlyFile(path: string, versions: { job?: number; durable?: number }): string {
    const database = new DatabaseSync(path);
    if (versions.job !== undefined) {
        database.exec("CREATE TABLE intern_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
        database.exec(`INSERT INTO intern_schema (id, version) VALUES (1, ${versions.job})`);
    }
    if (versions.durable !== undefined) {
        database.exec("CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
        database.exec(`INSERT INTO durable_schema (singleton, version) VALUES (1, ${versions.durable})`);
    }
    database.close();
    return path;
}

async function refusal(promise: Promise<unknown>): Promise<ImportRefusedError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ImportRefusedError, `expected ImportRefusedError, got ${String(error)}`);
        return error;
    }
    throw new Error("the import was not refused");
}

async function snapshot(directory: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const name of (await readdir(directory)).sort()) {
        result[name] = (await readFile(join(directory, name))).toString("base64");
    }
    return result;
}

describe("the import step", () => {
    it("restores every job of an export into a new instance and continues its counter", async () => {
        const { file, jobs, leadEntries } = await exportedFile();
        const target = await newEnv();

        await importDatabase({ stateDir: target.stateDir, file });
        const instance = await startInstance(target);

        const listed = await instance.invoke<{ jobs: Job[] }>("jobs.list", {});
        const numbers = listed.jobs.map((job) => job.number).sort();
        assert.deepEqual(numbers, jobs.map((job) => job.number).sort());
        const [first, second] = jobs as [Job, Job];
        const restored = await instance.invoke<Job>("jobs.get", { job: first.number });
        assert.deepEqual(restored.related, [second.number]);
        const worklog = await instance.invoke<{ entries?: { text?: string }[] }>("jobs.worklog.list", {
            job: first.number,
        });
        assert.ok(JSON.stringify(worklog).includes("a note"));
        const history = await instance.invoke<{ entries?: unknown[] }>("jobs.history.list", { job: first.number });
        assert.ok((history.entries?.length ?? 0) >= 1);
        assert.equal(await entryCount(instance, first.leadConversation), leadEntries);
        assert.ok(leadEntries > 0);
        const next = await instance.invoke<Job>("jobs.create", { text: "third" });
        const letter = first.number.split("-")[0];
        assert.equal(next.number, `${letter}-3`);
    });

    it("creates the imported database owner-only and leaves nothing else behind", async () => {
        const { file } = await exportedFile();
        const target = await newEnv();

        await importDatabase({ stateDir: target.stateDir, file });

        assert.equal((await stat(join(target.stateDir, DATABASE_NAME))).mode & 0o777, OWNER_ONLY);
        assert.deepEqual(await readdir(target.stateDir), [DATABASE_NAME]);
    });

    it("creates the database owner-only from a file that others can read", async () => {
        const target = await newEnv();
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: 1, durable: 1 });
        await chmod(file, 0o644);

        await importDatabase({ stateDir: target.stateDir, file });

        assert.equal((await stat(join(target.stateDir, DATABASE_NAME))).mode & 0o777, OWNER_ONLY);
    });

    it("opens a WAL-mode export without leaving files next to it", async () => {
        const { file } = await exportedFile();
        const folder = join(file, "..");
        const before = (await readdir(folder)).sort();

        await importDatabase({ stateDir: (await newEnv()).stateDir, file });

        assert.deepEqual((await readdir(folder)).sort(), before);
    });

    it("refuses when the state directory holds a database file", async () => {
        const target = await newEnv();
        const database = join(target.stateDir, DATABASE_NAME);
        await writeFile(database, "existing", { mode: OWNER_ONLY });
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: 1, durable: 1 });
        const before = await snapshot(target.stateDir);

        const error = await refusal(importDatabase({ stateDir: target.stateDir, file }));

        assert.match(error.message, /holds a database file/);
        assert.deepEqual(await snapshot(target.stateDir), before);
    });

    for (const suffix of ["-wal", "-shm"]) {
        it(`refuses when only a ${suffix} file is left`, async () => {
            const target = await newEnv();
            await writeFile(join(target.stateDir, `${DATABASE_NAME}${suffix}`), "leftover", { mode: OWNER_ONLY });
            const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: 1, durable: 1 });
            const before = await snapshot(target.stateDir);

            const error = await refusal(importDatabase({ stateDir: target.stateDir, file }));

            assert.match(error.message, new RegExp(`${DATABASE_NAME}${suffix}`));
            assert.deepEqual(await snapshot(target.stateDir), before);
        });
    }

    it("refuses while a daemon runs and changes nothing", async () => {
        const running = await startInstance(await newEnv());
        const file = versionOnlyFile(join(running.env.root, "export.sqlite"), { job: 1, durable: 1 });

        const error = await refusal(importDatabase({ stateDir: running.env.stateDir, file }));

        assert.match(error.message, /running daemon/);
        assert.ok(error.cause instanceof OwnershipRefusedError);
        assert.equal(running.daemon.phase(), "ready");
    });

    it("refuses a newer job schema naming both versions and changes nothing", async () => {
        const target = await newEnv();
        const newer = JOB_SCHEMA_VERSION + 1;
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: newer, durable: 1 });
        const before = await snapshot(target.stateDir);

        const error = await refusal(importDatabase({ stateDir: target.stateDir, file }));

        assert.match(error.message, /job schema/);
        assert.ok(error.message.includes(`version ${newer}`));
        assert.ok(error.message.includes(`version ${JOB_SCHEMA_VERSION}`));
        assert.deepEqual(await snapshot(target.stateDir), before);
    });

    it("refuses a newer pi-durable schema naming both versions and changes nothing", async () => {
        const target = await newEnv();
        const newer = CURRENT_SQLITE_SCHEMA_VERSION + 1;
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: 1, durable: newer });
        const before = await snapshot(target.stateDir);

        const error = await refusal(importDatabase({ stateDir: target.stateDir, file }));

        assert.match(error.message, /pi-durable schema/);
        assert.ok(error.message.includes(`version ${newer}`));
        assert.ok(error.message.includes(`version ${CURRENT_SQLITE_SCHEMA_VERSION}`));
        assert.deepEqual(await snapshot(target.stateDir), before);
    });

    it("refuses a file that is missing or is not a database and changes nothing", async () => {
        const target = await newEnv();
        const notDatabase = join(target.root, "plain.txt");
        await writeFile(notDatabase, "this is not a database file at all, just text");
        const before = await snapshot(target.stateDir);

        const missing = await refusal(importDatabase({ stateDir: target.stateDir, file: join(target.root, "nope") }));
        const plain = await refusal(importDatabase({ stateDir: target.stateDir, file: notDatabase }));

        assert.match(missing.message, /nope/);
        assert.match(plain.message, /not a SQLite database/);
        assert.deepEqual(await snapshot(target.stateDir), before);
    });

    it("refuses when the state directory does not exist", async () => {
        const target = await newEnv();
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: 1, durable: 1 });

        const error = await refusal(importDatabase({ stateDir: join(target.root, "absent"), file }));

        assert.match(error.message, /state directory .* does not exist/);
    });

    it("holds the single-owner lock while it runs, so a daemon started meanwhile is refused", async () => {
        const target = await newEnv();
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: 1, durable: 1 });
        const lines: string[] = [];
        let meanwhile: number | undefined;
        // A daemon that wrongly starts is stopped here, and the wait for its exit ends at the deadline.
        const deadline = (daemon: RunningDaemon) =>
            new Promise<undefined>((resolve) => {
                const timer = setTimeout(() => {
                    daemons.push(daemon);
                    resolve(undefined);
                }, WAIT_MS);
                timer.unref();
            });

        await importDatabase(
            { stateDir: target.stateDir, file },
            {
                whileOwned: async () => {
                    const daemon = runDaemon({
                        flags: {
                            configDir: target.configDir,
                            stateDir: target.stateDir,
                            dataDir: target.dataDir,
                            runtimeDir: target.runtimeDir,
                        },
                        env: target.env,
                        homeDir: target.root,
                        logger: createLogger({
                            stream: {
                                write: (line: string) => {
                                    lines.push(line);
                                    return true;
                                },
                            },
                        }),
                    });
                    meanwhile = await Promise.race([daemon.exited, deadline(daemon)]);
                },
            },
        );

        assert.equal(meanwhile, 1);
        assert.ok(lines.some((line) => /step=3/.test(line) && line.includes(`pid ${process.pid}`)));
        assert.deepEqual(await readdir(target.stateDir), [DATABASE_NAME]);
    });

    it("releases the lock after a refusal", async () => {
        const target = await newEnv();
        const file = versionOnlyFile(join(target.root, "export.sqlite"), { job: JOB_SCHEMA_VERSION + 1 });
        await refusal(importDatabase({ stateDir: target.stateDir, file }));

        assert.deepEqual(await readdir(target.stateDir), []);
    });
});
