/**
 * The mail policy (S-009 REQ-014, REQ-015; S-004 REQ-014): the mail a block or a completion owes, and the email details
 * `jobs.get` returns. The policy is built over a daemon's job store with the fake model; the accounts and the notice
 * settings are given directly.
 */
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
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
import type { MailDecision, OwedMail } from "../../src/jobs/mail_policy.ts";
import type { MailAccount, MailNotice } from "../../src/mail/mail_model.ts";
import type { NewOutboxRow } from "../../src/mail/mail_store.ts";
import { createMailPolicy } from "../../src/mail/outbox.ts";
import { writeSavedCopy } from "../../src/mail/saved_copy.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const lead: JobAuthor = { kind: "agent", conversationId: "c-1", role: "lead" };
const teamMember: JobAuthor = { kind: "team_member", wayIn: "web interface" };
const daemon: JobAuthor = { kind: "daemon" };
const SENDER = "ann@example.test";
const SUBJECT = "Please look at this";

const account = (extra: Partial<MailAccount> = {}): MailAccount => ({
    name: "work",
    kind: "owned",
    address: "bob@example.test",
    imapHost: "imap.example.test",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    smtpSecurity: "tls",
    login: "bob",
    auth: "password",
    checkIntervalSeconds: 60,
    allow: [],
    ...extra,
});

const NOTICE: MailNotice = { to: "team@example.test", from: "notices" };
const NOTICE_ACCOUNT = account({ name: "notices", address: "intern@example.test" });

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const running of daemons.splice(0)) await running.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Started = {
    ctx: ServiceContext;
    policy: (accounts: MailAccount[], notice: MailNotice | undefined) => ReturnType<typeof createMailPolicy>;
    /** Saves an email of the account into a started email job; returns the job. */
    emailJob(options?: { raw?: string; messageId?: string; attachments?: unknown[] }): Promise<Job>;
    plainJob(): Promise<Job>;
    block(job: Job): Promise<void>;
    owe(job: Job, row: Partial<NewOutboxRow>): Promise<void>;
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
    const deadline = Date.now() + WAIT_MS;
    while (running.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const ctx = captured as ServiceContext;
    let uid = 0;
    return {
        ctx,
        policy: (accounts, notice) =>
            createMailPolicy({
                jobStore: ctx.jobStore,
                accounts: () => accounts,
                notice: () => notice,
                mailDir: ctx.dirs.mailDir,
            }),
        async emailJob(options = {}) {
            uid += 1;
            const raw = options.raw ?? `From: ${SENDER}\r\nSubject: ${SUBJECT}\r\n\r\nhello`;
            const messageId = options.messageId ?? `<m${uid}@example.test>`;
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
                    attachments: options.attachments ?? [],
                    route: "new",
                    job: null,
                }),
            );
            const origin = { kind: "request", wayIn: "email" } as const;
            const email = { account: "work", savedId: saved.id, messageId };
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
            await writeSavedCopy(ctx.dirs.mailDir, saved.id, Buffer.from(raw));
            await ctx.jobStore.applyAction(job.id, "start", {}, daemon);
            return job;
        },
        async plainJob() {
            const origin = { kind: "request", wayIn: "web interface" } as const;
            const { job } = await ctx.jobStore.insertJob({ letter: "W", requestText: "typed", origin, leadStart: {} });
            await ctx.jobStore.applyAction(job.id, "start", {}, daemon);
            return job;
        },
        async block(job) {
            await ctx.jobStore.applyAction(job.id, "block", { blockedReason: "why" }, daemon);
            await ctx.jobStore.applyAction(job.id, "resume", {}, daemon);
        },
        async owe(job, row) {
            await ctx.jobStore.writeMail((tx) =>
                tx.insertOutbox({
                    key: `question:${job.id}:1`,
                    job: job.id,
                    account: "work",
                    kind: "question",
                    recipients: [SENDER],
                    subject: SUBJECT,
                    mailText: "Which schema?",
                    inReplyTo: null,
                    references: null,
                    ...row,
                }),
            );
        },
    };
}

function owedRow(decision: MailDecision): OwedMail {
    assert.equal(decision.kind, "owe");
    return (decision as { kind: "owe"; row: OwedMail }).row;
}

const asked = (job: Job, author: JobAuthor, mailText?: string) => ({ job, author, mailText });

describe("the mail a block owes", () => {
    it("owes a question to the sender in the job thread, from the account, with the starting subject (AC-1)", async () => {
        const started = await start();
        const job = await started.emailJob();
        const policy = started.policy([account({ allow: ["@example.test"] })], NOTICE);

        const row = owedRow(await policy.forBlock(asked(job, lead, "Which schema?")));

        assert.deepEqual(row, {
            key: `question:${job.id}:1`,
            account: "work",
            kind: "question",
            recipients: [SENDER],
            subject: SUBJECT,
            mailText: "Which schema?",
            inReplyTo: "<m1@example.test>",
            references: "<m1@example.test>",
        });
    });

    it("numbers the key by the job's blocks, this one included (AC-1)", async () => {
        const started = await start();
        const job = await started.emailJob();
        await started.block(job);
        const policy = started.policy([account()], undefined);

        const row = owedRow(await policy.forBlock(asked(job, lead, "Which schema?")));

        assert.equal(row.key, `question:${job.id}:2`);
    });

    it("owes the notice address from the notice account for a job that didn't come by email (AC-2)", async () => {
        const started = await start();
        const job = await started.plainJob();
        const policy = started.policy([account(), NOTICE_ACCOUNT], NOTICE);

        const row = owedRow(await policy.forBlock(asked(job, lead, "Which schema?\nSecond line")));

        assert.equal(row.account, "notices");
        assert.deepEqual(row.recipients, [NOTICE.to]);
        assert.equal(row.subject, "Which schema?");
        assert.equal(row.inReplyTo, null);
        assert.equal(row.references, null);
    });

    it("falls to the notice address when the account has no SMTP host (AC-2)", async () => {
        const started = await start();
        const job = await started.emailJob();
        const { smtpHost: _unused, ...monitored } = account();
        const policy = started.policy([monitored, NOTICE_ACCOUNT], NOTICE);

        const row = owedRow(await policy.forBlock(asked(job, lead, "Which schema?")));

        assert.equal(row.account, "notices");
        assert.equal(row.subject, SUBJECT);
    });

    it("falls to the notice address when the allowlist doesn't allow the sender (AC-2)", async () => {
        const started = await start();
        const job = await started.emailJob();
        const policy = started.policy([account({ allow: ["@other.test"] }), NOTICE_ACCOUNT], NOTICE);

        const row = owedRow(await policy.forBlock(asked(job, lead, "Which schema?")));

        assert.deepEqual(row.recipients, [NOTICE.to]);
    });

    it("owes nothing and needs no mail text with neither destination (AC-2)", async () => {
        const started = await start();
        const job = await started.plainJob();
        const policy = started.policy([account()], undefined);

        assert.deepEqual(await policy.forBlock(asked(job, lead)), { kind: "none" });
    });

    it("requires a mail text when there is a destination (AC-2)", async () => {
        const started = await start();
        const job = await started.emailJob();
        const policy = started.policy([account()], NOTICE);

        assert.deepEqual(await policy.forBlock(asked(job, lead)), { kind: "mail_text_required" });
    });

    it("replies in the notice thread to the first question's Message-ID once it is composed (AC-5)", async () => {
        const started = await start();
        const job = await started.plainJob();
        const policy = started.policy([account(), NOTICE_ACCOUNT], NOTICE);
        const first = await started.ctx.jobStore.writeMail((tx) =>
            tx.insertOutbox({
                key: `question:${job.id}:1`,
                job: job.id,
                account: "notices",
                kind: "question",
                recipients: [NOTICE.to],
                subject: "First",
                mailText: "First?",
                inReplyTo: null,
                references: null,
            }),
        );
        await started.block(job);
        await started.block(job);
        const beforeComposed = owedRow(await policy.forBlock(asked(job, lead, "Second?")));
        await started.ctx.jobStore.writeMail((tx) =>
            tx.setOutboxState(first.id, "sent", { messageId: "<first@example.test>" }),
        );

        const row = owedRow(await policy.forBlock(asked(job, lead, "Second?")));

        assert.equal(beforeComposed.inReplyTo, null);
        assert.equal(row.inReplyTo, "<first@example.test>");
        assert.equal(row.references, "<first@example.test>");
    });

    it("owes nothing for the newest question's text, but not for a held back one's (AC-3)", async () => {
        const started = await start();
        const job = await started.emailJob();
        const policy = started.policy([account()], NOTICE);
        await started.owe(job, { key: `question:${job.id}:1`, mailText: "Which schema?" });
        await started.owe(job, { key: `question:${job.id}:2`, mailText: "Other?" });
        const second = await started.ctx.jobStore.readMail((tx) => tx.outboxByKey(`question:${job.id}:2`));
        await started.ctx.jobStore.writeMail((tx) => tx.setOutboxState(second?.id as string, "held_back"));

        const repeated = await policy.forBlock(asked(job, lead, "Which schema?"));
        const heldBackText = await policy.forBlock(asked(job, lead, "Other?"));

        assert.deepEqual(repeated, { kind: "none" });
        assert.equal(heldBackText.kind, "owe");
    });

    it("owes nothing for a block by the daemon (AC-3)", async () => {
        const started = await start();
        const job = await started.emailJob();
        const policy = started.policy([account()], NOTICE);

        assert.deepEqual(await policy.forBlock(asked(job, daemon)), { kind: "none" });
    });
});

describe("the mail a completion owes", () => {
    it("owes a result reply with the mail text for a marked email job (AC-4)", async () => {
        const started = await start();
        const job = await started.emailJob();
        await started.ctx.jobStore.setRequestMark(job.id, true, lead);
        const marked = await started.ctx.jobStore.getJob(job.id);
        const policy = started.policy([account()], NOTICE);

        const row = owedRow(await policy.forComplete(asked(marked, lead, "All done.")));

        assert.deepEqual(row, {
            key: `result:${job.id}`,
            account: "work",
            kind: "result",
            recipients: [SENDER],
            subject: SUBJECT,
            mailText: "All done.",
            inReplyTo: "<m1@example.test>",
            references: "<m1@example.test>",
        });
    });

    it("answers mail_text_required to the lead and not_sent to a team member without a mail text (AC-4)", async () => {
        const started = await start();
        const job = await started.emailJob();
        await started.ctx.jobStore.setRequestMark(job.id, true, lead);
        const marked = await started.ctx.jobStore.getJob(job.id);
        const policy = started.policy([account()], NOTICE);

        assert.deepEqual(await policy.forComplete(asked(marked, lead)), { kind: "mail_text_required" });
        assert.deepEqual(await policy.forComplete(asked(marked, teamMember)), { kind: "not_sent" });
    });

    it("owes nothing for an unmarked job or one through an account without an SMTP host (AC-4)", async () => {
        const started = await start();
        const unmarked = await started.emailJob();
        const marked = await started.emailJob();
        await started.ctx.jobStore.setRequestMark(marked.id, true, lead);
        const { smtpHost: _unused, ...monitored } = account();

        const unmarkedAnswer = await started.policy([account()], NOTICE).forComplete(asked(unmarked, lead, "Done."));
        const noSmtpAnswer = await started
            .policy([monitored], NOTICE)
            .forComplete(asked(await started.ctx.jobStore.getJob(marked.id), lead, "Done."));

        assert.deepEqual(unmarkedAnswer, { kind: "none" });
        assert.deepEqual(noSmtpAnswer, { kind: "none" });
    });
});

const TWO_ATTACHMENTS = [
    "From: ann@example.test",
    "To: bob@example.test, team@example.test",
    "Cc: carl@example.test",
    `Subject: ${SUBJECT}`,
    "Date: Thu, 19 Nov 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "hello",
    "--b",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("pdf-bytes").toString("base64"),
    "--b",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("blob").toString("base64"),
    "--b--",
    "",
].join("\r\n");

describe("the email details of a job", () => {
    it("names each attachment with its size and an existing path (AC-5)", async () => {
        const started = await start();
        const job = await started.emailJob({
            raw: TWO_ATTACHMENTS,
            attachments: [
                { filename: "report.pdf", contentType: "application/pdf", size: 9 },
                { filename: null, contentType: "application/octet-stream", size: 4 },
            ],
        });
        const policy = started.policy([account()], NOTICE);

        const details = await policy.emailDetails(job);

        assert.equal(details?.account, "work");
        assert.equal(details?.sender, SENDER);
        assert.equal(details?.subject, SUBJECT);
        const attachments = details?.message?.attachments ?? [];
        assert.deepEqual(
            attachments.map(({ name, size }) => ({ name, size })),
            [
                { name: "report.pdf", size: 9 },
                { name: "2-attachment", size: 4 },
            ],
        );
        await access(details?.message?.path as string);
        for (const attachment of attachments) await access(attachment.path);
    });

    it("lists a received entry's To and Cc, and a sent entry's date from its composed bytes (AC-5)", async () => {
        const started = await start();
        const job = await started.emailJob({ raw: TWO_ATTACHMENTS });
        await started.owe(job, { recipients: [SENDER], subject: "Re: question" });
        const row = await started.ctx.jobStore.readMail((tx) => tx.outboxByKey(`question:${job.id}:1`));
        const sentBefore = await started.policy([account()], NOTICE).emailDetails(job);
        const composed =
            "From: bob@example.test\r\nDate: Fri, 20 Nov 2026 08:30:00 +0000\r\nSubject: Re: question\r\n\r\nx";
        await started.ctx.jobStore.writeMail((tx) =>
            tx.setOutboxState(row?.id as string, "sent", { messageId: "<s@example.test>", raw: Buffer.from(composed) }),
        );

        const details = await started.policy([account()], NOTICE).emailDetails(job);

        assert.deepEqual(details?.thread[0], {
            direction: "received",
            sender: SENDER,
            recipients: ["bob@example.test", "team@example.test", "carl@example.test"],
            subject: SUBJECT,
            date: "2026-11-19T10:00:00.000Z",
        });
        assert.equal(sentBefore?.thread[1]?.date, null);
        assert.deepEqual(details?.thread[1], {
            direction: "sent",
            sender: "bob@example.test",
            recipients: [SENDER],
            subject: "Re: question",
            date: "2026-11-20T08:30:00.000Z",
        });
    });

    it("uses the account address for a received entry with no To and Cc (AC-5)", async () => {
        const started = await start();
        const job = await started.emailJob();

        const details = await started.policy([account()], NOTICE).emailDetails(job);

        assert.deepEqual(details?.thread[0]?.recipients, ["bob@example.test"]);
    });

    it("gives nothing for a job that didn't come by email", async () => {
        const started = await start();
        const job = await started.plainJob();

        assert.equal(await started.policy([account()], NOTICE).emailDetails(job), undefined);
    });
});
