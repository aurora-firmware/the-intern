/**
 * Sending owed mail (S-009 REQ-012 to REQ-015, REQ-022; ADR-001 decision 4): each account's sender takes its `owed`
 * rows oldest first against the fake mail server. The senders run in the test process over a daemon's job store; the
 * accounts and the notice settings are given directly.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
import type { MailAccount, MailNotice } from "../../src/mail/mail_model.ts";
import type { OutboxRow, OutboxState } from "../../src/mail/mail_store.ts";
import { parseMessage } from "../../src/mail/mime.ts";
import { createMailPolicy, createOutbox, type Outbox } from "../../src/mail/outbox.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const lead: JobAuthor = { kind: "agent", conversationId: "c-1", role: "lead" };
const daemon: JobAuthor = { kind: "daemon" };
const teamMember: JobAuthor = { kind: "team_member", wayIn: "web interface" };
const ADDRESS = "bob@example.test";
const PASSWORD = "pw";
const SENDER = "ana@example.test";
const SUBJECT = "Please look at this";
const NOTICE: MailNotice = { to: "team@example.test", from: "notices" };

const account = (extra: Partial<MailAccount> = {}): MailAccount => ({
    name: "work",
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
    ...extra,
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

async function untilTrue(description: string, isWanted: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await isWanted())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function closedPort(): Promise<number> {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as { port: number };
    await new Promise((resolve) => holder.close(resolve));
    return port;
}

type World = {
    ctx: ServiceContext;
    server: FakeMailServer;
    outbox: Outbox;
    /** The accounts and the notice settings the senders read at each pass; a test changes them. */
    accounts: MailAccount[];
    settings: { notice: MailNotice | undefined; isReady: boolean };
    failures: { name: string; message: string }[];
    emailJob(): Promise<Job>;
    plainJob(): Promise<Job>;
    /** Blocks the job by its lead with the mail text, as the block action does: the policy's row, then the wake. */
    block(job: Job, mailText: string): Promise<void>;
    complete(job: Job, mailText: string): Promise<void>;
    rowsIn(state: OutboxState): Promise<OutboxRow[]>;
    mailHistory(job: Job): Promise<{ mail: string; [field: string]: unknown }[]>;
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
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const running = runDaemon({
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
    daemons.push(running);
    await untilTrue("the daemon to become ready", () => running.phase() === "ready");
    const ctx = captured as ServiceContext;
    const accounts = [
        account({ smtpPort: server.smtpPort }),
        account({ name: "notices", address: "intern@example.test", smtpPort: server.smtpPort }),
    ];
    const settings = { notice: NOTICE as MailNotice | undefined, isReady: true };
    const failures: { name: string; message: string }[] = [];
    const outbox = createOutbox({
        jobStore: ctx.jobStore,
        accounts: () => accounts,
        notice: () => settings.notice,
        credential: async (owned) => ({ user: owned.login, password: PASSWORD }),
        isReady: () => settings.isReady,
        fail: (name, message) => {
            settings.isReady = false;
            failures.push({ name, message });
        },
        logger: quietLogger,
    });
    outboxes.push(outbox);
    const policy = createMailPolicy({
        jobStore: ctx.jobStore,
        accounts: () => accounts,
        notice: () => settings.notice,
        mailDir: ctx.dirs.mailDir,
        committed: () => outbox.wake(),
    });
    let uid = 0;
    const startedJob = async (job: Job): Promise<Job> => {
        await ctx.jobStore.applyAction(job.id, "start", {}, daemon);
        return job;
    };
    return {
        ctx,
        server,
        outbox,
        accounts,
        settings,
        failures,
        async emailJob() {
            uid += 1;
            const raw = `From: ${SENDER}\r\nSubject: ${SUBJECT}\r\n\r\nhello`;
            const messageId = `<m${uid}@example.test>`;
            const saved = await ctx.jobStore.writeMail((tx) =>
                tx.saveMessage({
                    account: "work",
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
                    attachments: [],
                    route: "new",
                    job: null,
                }),
            );
            const origin = { kind: "request", wayIn: "email" } as const;
            const { job } = await ctx.jobStore.insertJob({
                letter: "E",
                requestText: "mail",
                origin,
                email: { account: "work", savedId: saved.id, messageId },
                leadStart: {},
            });
            await ctx.jobStore.writeMail((tx) =>
                tx.recordIntakeOutcome(saved.id, { outcome: "job_created", job: job.id }),
            );
            return startedJob(job);
        },
        async plainJob() {
            const origin = { kind: "request", wayIn: "web interface" } as const;
            const { job } = await ctx.jobStore.insertJob({ letter: "W", requestText: "typed", origin, leadStart: {} });
            return startedJob(job);
        },
        async block(job, mailText) {
            const decision = await policy.forBlock({ job, author: lead, mailText });
            assert.equal(decision.kind, "owe");
            const owedMail = (decision as { kind: "owe"; row: NonNullable<unknown> }).row as never;
            await ctx.jobStore.applyAction(job.id, "block", { blockedReason: "needs input", owedMail }, lead);
            policy.committed();
        },
        async complete(started, mailText) {
            await ctx.jobStore.updateFields(started.id, { definitionOfDone: "Answered" }, teamMember);
            const job = await ctx.jobStore.getJob(started.id);
            const decision = await policy.forComplete({ job, author: lead, mailText });
            const owedMail = decision.kind === "owe" ? decision.row : undefined;
            await ctx.jobStore.applyAction(
                job.id,
                "complete",
                { justification: "the internal justification", ...(owedMail && { owedMail }) },
                lead,
            );
            policy.committed();
        },
        rowsIn: (state) => ctx.jobStore.readMail((tx) => tx.rowsInState(state)),
        async mailHistory(job) {
            const { entries } = await ctx.jobStore.listHistory(job.id, {});
            return entries.filter((entry) => entry.field === "mail").map((entry) => entry.new as never);
        },
    };
}

const received = (world: World) => world.server.received();

async function untilReceived(world: World, count: number): Promise<void> {
    await untilTrue(`${count} sent email(s)`, () => received(world).length >= count);
}

describe("sending owed mail", () => {
    it("sends the question of a block to the sender, as a reply with the mail text only (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start();
        world.outbox.startAccount(world.accounts[0] as MailAccount);
        const job = await world.emailJob();

        await world.block(job, "Which schema?");

        await untilReceived(world, 1);
        const [mail] = received(world);
        assert.deepEqual(mail?.envelope.to, [SENDER]);
        const parsed = await parseMessage(mail?.raw as Buffer);
        assert.equal(parsed.text.trim(), "Which schema?");
        assert.equal(parsed.subject, SUBJECT);
        assert.equal(parsed.from, ADDRESS);
        assert.equal(parsed.inReplyTo, "<m1@example.test>");
        await untilTrue("the row to be sent", async () => (await world.rowsIn("sent")).length === 1);
        const [row] = await world.rowsIn("sent");
        assert.equal(row?.messageId, parsed.messageId);
        const thread = await world.ctx.jobStore.readMail((tx) => tx.jobsOfMessageIds([parsed.messageId as string]));
        assert.equal(thread.get(parsed.messageId as string), job.id);
        const sent = (await world.mailHistory(job)).filter((entry) => entry.mail === "sent");
        assert.deepEqual(sent, [{ mail: "sent", from: ADDRESS, to: [SENDER], subject: SUBJECT }]);
    });

    it("replies only for the marked job completed with a mail text, with that text and not the justification (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start();
        world.outbox.startAccount(world.accounts[0] as MailAccount);
        const [first, second, third] = [await world.emailJob(), await world.emailJob(), await world.emailJob()] as [
            Job,
            Job,
            Job,
        ];
        await world.ctx.jobStore.setRequestMark(first.id, true, teamMember);
        await world.ctx.jobStore.setRequestMark(third.id, true, teamMember);

        await world.complete(first, "All done.");
        await world.complete(second, "Unmarked text.");
        await world.ctx.jobStore.applyAction(third.id, "cancel", { justification: "no longer needed" }, lead);

        await untilReceived(world, 1);
        const [mail] = received(world);
        const parsed = await parseMessage(mail?.raw as Buffer);
        assert.equal(parsed.text.trim(), "All done.");
        assert.equal(parsed.inReplyTo, "<m1@example.test>");
        assert.doesNotMatch(parsed.text, /justification/);
        assert.equal(received(world).length, 1);
    });

    it("holds back an owed email whose recipient is no longer allowed and sends one notice (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start();
        const job = await world.emailJob();
        await world.block(job, "Which schema?");
        const owner = world.accounts[0] as MailAccount;
        owner.allow = ["@other.test"];

        world.outbox.startAccount(owner);
        world.outbox.startAccount(world.accounts[1] as MailAccount);

        await untilReceived(world, 1);
        const [mail] = received(world);
        assert.deepEqual(mail?.envelope.to, [NOTICE.to]);
        const parsed = await parseMessage(mail?.raw as Buffer);
        assert.match(parsed.subject, /held back/i);
        assert.equal(parsed.from, "intern@example.test");
        const [held] = await world.rowsIn("held_back");
        assert.deepEqual(held?.recipients, [SENDER]);
        const history = await world.mailHistory(job);
        assert.deepEqual(
            history.filter((entry) => entry.mail === "held_back"),
            [{ mail: "held_back", from: ADDRESS, to: [SENDER], subject: SUBJECT, notAllowed: [SENDER] }],
        );
        await untilTrue("the notice to be sent", async () => (await world.rowsIn("sent")).length === 1);
        assert.equal((await world.rowsIn("sent"))[0]?.key, `notice:${held?.id}`);
        assert.equal(received(world).length, 1);
    });

    it("tries a refused result reply and a refused question to the notice address once each, with one notice (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start();
        world.outbox.startAccount(world.accounts[0] as MailAccount);
        world.outbox.startAccount(world.accounts[1] as MailAccount);
        world.server.refuseRecipient(SENDER, "550 5.1.1 no such user");
        world.server.refuseRecipient(NOTICE.to, "550 5.7.1 notice refused");
        const emailJob = await world.emailJob();
        await world.ctx.jobStore.setRequestMark(emailJob.id, true, teamMember);

        await world.complete(emailJob, "All done.");
        const plain = await world.plainJob();
        await world.block(plain, "Which schema?");

        await untilTrue("both rows to be refused", async () => (await world.rowsIn("refused")).length >= 3);
        const refusedRows = await world.rowsIn("refused");
        assert.deepEqual(
            refusedRows.map((row) => row.key).sort(),
            [
                `question:${plain.id}:1`,
                `refused:${refusedRows.find((row) => row.key === `result:${emailJob.id}`)?.id}`,
                `result:${emailJob.id}`,
            ].sort(),
        );
        const result = refusedRows.find((row) => row.key === `result:${emailJob.id}`);
        assert.match(result?.serverAnswer as string, /no such user/);
        const question = refusedRows.find((row) => row.key === `question:${plain.id}:1`);
        assert.match(question?.serverAnswer as string, /notice refused/);
        const entries = (await world.mailHistory(emailJob)).filter((entry) => entry.mail === "refused");
        assert.equal(entries[0]?.serverAnswer, result?.serverAnswer);
        assert.equal((await world.mailHistory(plain)).filter((entry) => entry.mail === "refused").length, 1);
        assert.equal(world.server.received().length, 0);
        assert.equal((await world.rowsIn("owed")).length, 0);
    });

    it("keeps the row owed when the server fails before taking it, and sends it once the account is ready (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start();
        const owner = world.accounts[0] as MailAccount;
        owner.smtpPort = await closedPort();
        world.outbox.startAccount(owner);
        const job = await world.emailJob();

        await world.block(job, "Which schema?");

        await untilTrue("the account to be reported failing", () => world.failures.length === 1);
        assert.equal(world.failures[0]?.name, "work");
        assert.equal((await world.rowsIn("owed")).length, 1);
        assert.equal(received(world).length, 0);
        owner.smtpPort = world.server.smtpPort;
        world.settings.isReady = true;
        world.outbox.startAccount(owner);
        await untilReceived(world, 1);
        await untilTrue("the row to be sent", async () => (await world.rowsIn("sent")).length === 1);
        assert.equal((await world.rowsIn("owed")).length, 0);
        assert.equal(received(world).length, 1);
    });
});
