/**
 * `bob jobs` for email jobs (T-447, S-005 REQ-004, S-009 REQ-017, AC-017.1): `list --mail` keeps one account's jobs,
 * `show` prints the email section of an email job and none for another, and `complete --mail-text` completes a marked
 * email job whose sender receives the text. The daemon runs in this process, with its local socket, the mail policy
 * and the sender over the fake mail server.
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
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import type { Job } from "../../src/jobs/job_store.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { setMailPolicy } from "../../src/jobs/mail_policy.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import type { MailAccount } from "../../src/mail/mail_model.ts";
import { parseMessage } from "../../src/mail/mime.ts";
import { createMailPolicy, createOutbox, type Outbox } from "../../src/mail/outbox.ts";
import { runBob } from "../support/bob_process.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const daemonAuthor: JobAuthor = { kind: "daemon" };
const ADDRESS = "bob@example.test";
const PASSWORD = "pw";
const SENDER = "ann@example.test";
const SUBJECT = "Please look at this";

const account = (name: string): MailAccount => ({
    name,
    kind: "owned",
    address: ADDRESS,
    imapHost: "127.0.0.1",
    imapPort: 143,
    imapSecurity: "none",
    smtpHost: "127.0.0.1",
    smtpPort: 25,
    smtpSecurity: "none",
    login: ADDRESS,
    auth: "password",
    checkIntervalSeconds: 60,
    allow: [],
});

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const servers: FakeMailServer[] = [];
const outboxes: Outbox[] = [];

afterEach(async () => {
    for (const outbox of outboxes.splice(0)) await outbox.stopAll();
    for (const running of daemons.splice(0)) await running.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const server of servers.splice(0)) await server.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

async function untilTrue(description: string, isWanted: () => boolean): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!isWanted()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

type World = {
    env: HermeticEnv;
    server: FakeMailServer;
    ctx: ServiceContext;
    bob(args: string[]): ReturnType<typeof runBob>;
    emailJob(accountName: string, startsAt: number): Promise<Job>;
    plainJob(): Promise<Job>;
};

async function start(): Promise<World> {
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
    const server = await startFakeMailServer();
    servers.push(server);
    server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = { name: "probe", start: async (ctx) => void (captured = ctx) };
    const running = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, jobs.component, createLocalSocketComponent(), probe],
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
    daemons.push(running);
    await untilTrue("the daemon to become ready", () => running.phase() === "ready");
    const ctx = captured as ServiceContext;
    const accounts = ["intern", "work"].map((name) => ({ ...account(name), smtpPort: server.smtpPort }));
    const outbox = createOutbox({
        jobStore: ctx.jobStore,
        accounts: () => accounts,
        notice: () => undefined,
        credential: async (owned) => ({ user: owned.login, password: PASSWORD }),
        isReady: () => true,
        fail: () => {},
        logger: quietLogger,
    });
    outboxes.push(outbox);
    for (const owned of accounts) outbox.startAccount(owned);
    setMailPolicy(
        ctx.host,
        createMailPolicy({
            jobStore: ctx.jobStore,
            accounts: () => accounts,
            notice: () => undefined,
            mailDir: ctx.dirs.mailDir,
            committed: () => outbox.wake(),
        }),
    );
    const startedJob = async (job: Job): Promise<Job> => {
        await ctx.jobStore.applyAction(job.id, "start", {}, daemonAuthor);
        return job;
    };
    return {
        env,
        server,
        ctx,
        bob: (args) => runBob(args, { runtimeDir: env.runtimeDir, env: env.env }),
        async emailJob(accountName, uid) {
            const raw = `From: ${SENDER}\r\nSubject: ${SUBJECT}\r\n\r\nhello`;
            const messageId = `<m${uid}@example.test>`;
            const saved = await ctx.jobStore.writeMail((tx) =>
                tx.saveMessage({
                    account: accountName,
                    uidvalidity: 1,
                    uid,
                    messageId,
                    inReplyTo: null,
                    references: null,
                    sender: SENDER,
                    subject: SUBJECT,
                    date: "2026-11-19T10:00:00.000Z",
                    raw: Buffer.from(raw),
                    size: raw.length,
                    attachments: [{ filename: "a.pdf", size: 12 }],
                    route: "new",
                    job: null,
                }),
            );
            const origin = { kind: "request", wayIn: "email" } as const;
            const email = { account: accountName, savedId: saved.id, messageId };
            const { job } = await ctx.jobStore.insertJob({
                letter: "E",
                requestText: "mail",
                origin,
                email,
                leadStart: {},
            });
            await ctx.jobStore.writeMail((tx) =>
                tx.recordIntakeOutcome(saved.id, { outcome: "job_created", job: job.id }),
            );
            return startedJob(job);
        },
        async plainJob() {
            const origin = { kind: "request", wayIn: "command line" } as const;
            const { job } = await ctx.jobStore.insertJob({ letter: "C", requestText: "typed", origin, leadStart: {} });
            return startedJob(job);
        },
    };
}

const scenario = (name: string, run: () => Promise<void>) => it(name, { timeout: TEST_TIMEOUT_MS }, run);

describe("bob jobs with email", () => {
    scenario("lists only the jobs of the account --mail names (AC-1)", async () => {
        const world = await start();
        const intern = await world.emailJob("intern", 1);
        const work = await world.emailJob("work", 2);

        const listed = await world.bob(["jobs", "list", "--mail", "intern"]);

        assert.equal(listed.status, 0, listed.stderr);
        assert.match(listed.stdout, new RegExp(intern.number));
        assert.doesNotMatch(listed.stdout, new RegExp(work.number));
    });

    scenario("shows an email job's account, sender, subject, message, attachments, thread and mark (AC-2)", async () => {
        const world = await start();
        const job = await world.emailJob("intern", 1);
        await world.ctx.jobStore.setRequestMark(job.id, true, daemonAuthor);

        const shown = await world.bob(["jobs", "show", job.number]);

        assert.equal(shown.status, 0, shown.stderr);
        assert.match(shown.stdout, /^Email:$/m);
        assert.match(shown.stdout, /Account: intern/);
        assert.match(shown.stdout, new RegExp(`Sender: ${SENDER}`));
        assert.match(shown.stdout, new RegExp(`Subject: ${SUBJECT}`));
        assert.match(shown.stdout, /Request mark: true/);
        assert.match(shown.stdout, /Saved message: \S*message\.eml/);
        assert.match(shown.stdout, /Attachment: a\.pdf \(12 bytes\) \S*a\.pdf/);
        assert.match(shown.stdout, new RegExp(`received ${SENDER} -> ${ADDRESS}: ${SUBJECT}`));
    });

    scenario("carries the email data in the --json of show (AC-2)", async () => {
        const world = await start();
        const job = await world.emailJob("intern", 1);

        const shown = await world.bob(["jobs", "show", job.number, "--json"]);

        const data = JSON.parse(shown.stdout) as { "jobs.get": { email: { account: string }; requestMark: string } };
        assert.equal(data["jobs.get"].email.account, "intern");
        assert.equal(data["jobs.get"].requestMark, "false");
    });

    scenario("prints no email section for a job that didn't come by email (AC-4)", async () => {
        const world = await start();
        const job = await world.plainJob();

        const shown = await world.bob(["jobs", "show", job.number]);

        assert.equal(shown.status, 0, shown.stderr);
        assert.doesNotMatch(shown.stdout, /Email:|Request mark:/);
    });

    scenario("completes a marked email job with --mail-text and the sender receives the text (AC-3)", async () => {
        const world = await start();
        const job = await world.emailJob("intern", 1);
        await world.ctx.jobStore.setRequestMark(job.id, true, daemonAuthor);
        await world.ctx.jobStore.updateFields(job.id, { definitionOfDone: "Answered" }, daemonAuthor);

        const done = await world.bob(["jobs", "complete", job.number, "answered", "--mail-text", "All done."]);

        assert.equal(done.status, 0, done.stderr);
        assert.match(done.stdout, /Done/);
        await untilTrue("the result reply", () => world.server.received().length >= 1);
        const [mail] = world.server.received();
        assert.deepEqual(mail?.envelope.to, [SENDER]);
        assert.equal((await parseMessage(mail?.raw as Buffer)).text.trim(), "All done.");
    });
});
