/**
 * The job an email makes (S-004 REQ-003, S-002 REQ-012, S-003 REQ-007): Email's intake calls `createJob` in-process
 * with the way in `email` and the account in the caller's observed details, and no listener can claim that origin.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import { createJobStore, migrateJobStore, type NewJob } from "../../src/jobs/job_store.ts";
import { createJobsComponent, type JobsComponentOptions } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import { type CreateJobRequest, createJob, type JobView } from "../../src/service/job_operations.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const TEST_TIMEOUT_MS = scaled(60_000);
const LOOPBACK = "127.0.0.1";
const quietLogger = createLogger({ stream: { write: () => true } });

const OBSERVED = { account: "work", messageId: "<m1@example.test>", sender: "ann@example.test" };
const EMAIL_CALLER: Caller = { actor: { kind: "team_member", wayIn: "email", observed: OBSERVED } };
const EMAIL_ORIGIN = { kind: "request", wayIn: "email", observed: OBSERVED };

type Db = Awaited<ReturnType<typeof openHostDatabase>>;
type Listener = "local socket" | "network listener";
type Answer = { status: number; body: { result?: unknown; error?: { code: string } } };
type Started = {
    ctx: ServiceContext;
    options: JobsComponentOptions;
    post(listener: Listener, input: unknown): Promise<Answer>;
};

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: { unregister(): void }[] = [];
const databases: Db[] = [];

afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
    for (const daemon of daemons.splice(0)) await Promise.race([daemon.stop(), sleep(STOP_BOUND_MS)]);
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJson(target: object, input: unknown): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const options = { ...target, method: "POST", path: "/operations/jobs.create" };
        const call = request({ ...options, headers: { "content-type": "application/json" } }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                resolve({ status: response.statusCode ?? 0, body });
            });
            response.once("error", reject);
        });
        call.once("error", reject);
        call.end(JSON.stringify(input));
    });
}

async function start(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    await writeFile(join(env.configDir, "config.toml"), `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const network = createNetworkListenerComponent({ freePort: true });
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
        sections: [...agents.sections, networkSection],
        components: [agents.component, jobs.component, createLocalSocketComponent(), network, probe],
        operations: [...agents.operations, ...jobs.operations],
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
        await sleep(POLL_MS);
    }
    const socketPath = localSocketPath(env.runtimeDir);
    const post = (listener: Listener, input: unknown) => {
        const address = network.address();
        assert.ok(address, "the network listener is running");
        return postJson(listener === "local socket" ? { socketPath } : address, input);
    };
    return { ctx: captured as ServiceContext, options: jobs.options, post };
}

function emailRequest(savedId: string, extra: Partial<CreateJobRequest> = {}): CreateJobRequest {
    return {
        text: "Please look at this",
        idempotencyKey: `mail:${savedId}`,
        email: { account: "work", savedId, messageId: OBSERVED.messageId },
        ...extra,
    };
}

describe("createJob for an email", { timeout: TEST_TIMEOUT_MS }, () => {
    it("creates an E job whose origin holds the account, Message-ID and sender, with the request mark false", async () => {
        const { ctx, options } = await start();

        const job = await createJob(ctx, options, emailRequest("saved-1"), EMAIL_CALLER);

        assert.match(job.number, /^E-[1-9][0-9]*$/);
        assert.deepEqual(job.request.origin, EMAIL_ORIGIN);
        assert.equal(job.mailAccount, "work");
        assert.equal(job.requestMark, "false");
    });

    it("returns the first job and creates no second one when the same mail key is used twice", async () => {
        const { ctx, options } = await start();

        const first = await createJob(ctx, options, emailRequest("saved-2"), EMAIL_CALLER);
        const second = await createJob(ctx, options, emailRequest("saved-2"), EMAIL_CALLER);

        assert.equal(second.id, first.id);
        assert.equal((await ctx.jobStore.listJobs({})).jobs.length, 1);
    });

    it("keeps the mail intake key space apart from jobs.create's", async () => {
        const { ctx, options } = await start();
        const caller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

        const plain = await createJob(ctx, options, { text: "plain", idempotencyKey: "mail:saved-3" }, caller);
        const mail = await createJob(ctx, options, emailRequest("saved-3"), EMAIL_CALLER);

        assert.notEqual(mail.id, plain.id);
    });

    it("relates the job to the one it names and records the thread row of its Message-ID", async () => {
        const { ctx, options } = await start();
        const earlier = await createJob(ctx, options, emailRequest("saved-4"), EMAIL_CALLER);
        const reply = { account: "work", savedId: "saved-5", messageId: "<m2@example.test>" };
        const caller: Caller = {
            actor: { kind: "team_member", wayIn: "email", observed: { ...OBSERVED, messageId: reply.messageId } },
        };

        const later: JobView = await createJob(
            ctx,
            options,
            emailRequest("saved-5", { email: reply, relatedTo: earlier.id }),
            caller,
        );

        assert.deepEqual(later.related, [earlier.number]);
        const jobs = await ctx.jobStore.readMail((tx) => tx.jobsOfMessageIds([reply.messageId]));
        assert.equal(jobs.get(reply.messageId), later.id);
    });

    it("creates the job without a thread row when the email has no Message-ID", async () => {
        const { ctx, options } = await start();
        const { messageId: _omitted, ...observed } = OBSERVED;
        const caller: Caller = { actor: { kind: "team_member", wayIn: "email", observed } };

        const job = await createJob(
            ctx,
            options,
            emailRequest("saved-6", { email: { account: "work", savedId: "saved-6" } }),
            caller,
        );

        assert.deepEqual(job.request.origin, { kind: "request", wayIn: "email", observed });
    });
});

async function openMigrated(): Promise<{ db: Db; store: ReturnType<typeof createJobStore> }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const db = await openHostDatabase(join(env.dataDir, "bob.sqlite"));
    databases.push(db);
    await migrateJobStore(db);
    return { db, store: createJobStore(db) };
}

const storeJob = (extra: Partial<NewJob> = {}): NewJob => ({
    letter: "E",
    requestText: "a request",
    origin: { kind: "request", wayIn: "email" },
    leadStart: { role: "triage" },
    ...extra,
});

describe("the job store's insert of an email job", () => {
    it("writes the mail columns, the key in mail.intake and the thread row in one commit", async () => {
        const { db, store } = await openMigrated();

        const { job } = await store.insertJob(
            storeJob({
                idempotencyKey: "mail:saved-7",
                idempotencyScope: "mail.intake",
                email: { account: "work", savedId: "saved-7", messageId: "<m7@example.test>" },
            }),
        );

        const row = await db.get<{ mail_account: string; mail_message: string; request_mark: string }>(
            "SELECT mail_account, mail_message, request_mark FROM intern_jobs WHERE id = ?",
            job.id,
        );
        assert.deepEqual({ ...row }, { mail_account: "work", mail_message: "saved-7", request_mark: "false" });
        const key = await db.get<{ job: string }>(
            "SELECT job FROM intern_job_keys WHERE scope = 'mail.intake' AND key = 'mail:saved-7'",
        );
        assert.equal(key?.job, job.id);
        const thread = await db.all<{ job: string; direction: string }>(
            "SELECT job, direction FROM intern_mail_thread WHERE message_id = '<m7@example.test>'",
        );
        assert.deepEqual(
            thread.map((entry) => ({ ...entry })),
            [{ job: job.id, direction: "in" }],
        );
    });

    it("writes nothing when the job to relate to does not exist", async () => {
        const { db, store } = await openMigrated();

        await assert.rejects(
            store.insertJob(
                storeJob({
                    idempotencyKey: "mail:saved-8",
                    idempotencyScope: "mail.intake",
                    relatedTo: "E-99",
                    email: { account: "work", savedId: "saved-8", messageId: "<m8@example.test>" },
                }),
            ),
        );

        for (const table of ["intern_jobs", "intern_job_keys", "intern_mail_thread"]) {
            const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
            assert.equal(count?.n, 0, `${table} is empty`);
        }
    });

    it("writes no thread row for an email without a Message-ID", async () => {
        const { db, store } = await openMigrated();

        await store.insertJob(storeJob({ email: { account: "work", savedId: "saved-9" } }));

        const count = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM intern_mail_thread");
        assert.equal(count?.n, 0);
    });
});

describe("a jobs.create through a listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of ["local socket", "network listener"] as const) {
        it(`refuses an email origin over the ${listener} and creates no job`, async () => {
            const { ctx, post } = await start();

            const answer = await post(listener, { text: "go", origin: EMAIL_ORIGIN });

            assert.equal(answer.status, 400);
            assert.equal(answer.body.error?.code, "invalid_input");
            assert.equal((await ctx.jobStore.listJobs({})).jobs.length, 0);
        });

        it(`ignores an email and a related job in the input over the ${listener}`, async () => {
            const { post } = await start();
            const claims = { text: "go", email: { account: "work", savedId: "x" }, relatedTo: "E-1" };

            const answer = await post(listener, claims);

            const created = answer.body.result as JobView;
            assert.equal(answer.status, 200);
            assert.match(created.number, /^[CW]-1$/);
            assert.equal(created.mailAccount, undefined);
            assert.deepEqual(created.related, []);
        });
    }
});
