/**
 * The mail component's startup repair (S-009 REQ-022, REQ-003, REQ-024; ADR-001 decision 4; ADR-011 decisions 2 and 4):
 * a first daemon of this process, without the mail component, leaves the saved state a kill at the point would leave
 * (the same job store writes the sender makes), it stops, and a second daemon with the mail component starts on the
 * same directories and settles it before the host resumes.
 */
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import type { Job } from "../../src/jobs/job_store.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createMailComponent, type MailComponent, type MailWritePoint } from "../../src/mail/mail_component.ts";
import type { MailAccount } from "../../src/mail/mail_model.ts";
import type { OutboxRow, OutboxState } from "../../src/mail/mail_store.ts";
import { createMailPolicy } from "../../src/mail/outbox.ts";
import { hasSavedCopy, writeSavedCopy } from "../../src/mail/saved_copy.ts";
import { type DaemonProcess, startDaemon as startChildDaemon } from "../support/daemon_process.ts";
import { type FakeMailServer, startFakeMailServer, TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const lead: JobAuthor = { kind: "agent", conversationId: "c-1", role: "lead" };
const teamMember: JobAuthor = { kind: "team_member", wayIn: "web interface" };
const PASSWORD = "pw";
const CLOCK_START = "2026-03-02T09:00:00.000Z";
const SENDER = "ana@example.test";
const SUBJECT = "Please look at this";
const RAW_EMAIL = `From: ${SENDER}\r\nSubject: ${SUBJECT}\r\n\r\nhello`;

const address = (name: string): string => `${name}@example.test`;

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const servers: FakeMailServer[] = [];
const children: DaemonProcess[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        child.kill9();
        await child.exited;
    }
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

type Rig = { env: HermeticEnv; server: FakeMailServer; fake: FauxProviderRegistration };

async function startRig(accountNames: string[]): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fake.setResponses([async () => fauxAssistantMessage("done")]);
    fakes.push(fake);
    const server = await startFakeMailServer();
    servers.push(server);
    for (const name of accountNames) {
        server.addAccount({ address: address(name), login: address(name), password: PASSWORD });
    }
    return { env, server, fake };
}

const accountOf = (rig: Rig, name: string): MailAccount => ({
    name,
    kind: "owned",
    address: address(name),
    imapHost: "127.0.0.1",
    imapPort: rig.server.imapPort,
    imapSecurity: "none",
    smtpHost: "127.0.0.1",
    smtpPort: rig.server.smtpPort,
    smtpSecurity: "none",
    login: address(name),
    auth: "password",
    checkIntervalSeconds: 60,
    allow: [],
});

/** Writes `config.toml` with the named owned accounts, none for an empty list. */
async function writeConfig(rig: Rig, names: string[]): Promise<void> {
    const sections = names.map(
        (name) =>
            `[[mail_account]]\nname = "${name}"\nkind = "owned"\naddress = "${address(name)}"\n` +
            `imap_host = "127.0.0.1"\nimap_port = ${rig.server.imapPort}\nimap_security = "none"\n` +
            `smtp_host = "127.0.0.1"\nsmtp_port = ${rig.server.smtpPort}\nsmtp_security = "none"\n` +
            `auth = "password_command"\npassword_command = ["printf", "%s", "${PASSWORD}"]\n`,
    );
    await writeFile(join(rig.env.configDir, "config.toml"), sections.join("\n"));
}

type Started = { ctx: ServiceContext; running: RunningDaemon; mail?: MailComponent };

/** A daemon over the rig's directories, with the mail component when `withMail`; it is ready when this returns. */
async function startDaemon(rig: Rig, withMail: boolean): Promise<Started> {
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const mail = withMail ? await createMailComponent({ agents, jobs, logger: quietLogger }) : undefined;
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const { env, fake } = rig;
    // A child writes its own fake model as the default and leaves one that exists, so each owner writes it afresh.
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: "model-one" }),
    );
    const running = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, ...(mail?.sections ?? [])],
        components: [agents.component, jobs.component, ...(mail ? [mail.component] : []), probe],
        operations: [...agents.operations, ...jobs.operations, ...(mail?.operations ?? [])],
        ...(mail && { accountStatus: mail.accountStatus }),
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: fake.getModel().provider,
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
    return { ctx: captured as ServiceContext, running, ...(mail && { mail }) };
}

/** Stops the daemon, as the end of the process a kill would be. */
async function stopDaemon(started: Started): Promise<void> {
    await started.running.stop();
    daemons.splice(daemons.indexOf(started.running), 1);
}

const untilReady = (started: Started, name: string) =>
    untilTrue(`account ${name} to be ready`, () => started.mail?.accountStatus.get("mail", name)?.status === "ready");

let uid = 0;

/** A started job that came by email on `account`, with the saved email and no copy folder. */
async function emailJob(ctx: ServiceContext, account: string): Promise<Job> {
    uid += 1;
    const messageId = `<m${uid}@example.test>`;
    const saved = await ctx.jobStore.writeMail((tx) =>
        tx.saveMessage({
            account,
            uidvalidity: 1,
            uid,
            messageId,
            inReplyTo: null,
            references: null,
            sender: SENDER,
            subject: SUBJECT,
            date: "2026-11-19T10:00:00.000Z",
            raw: Buffer.from(RAW_EMAIL),
            size: RAW_EMAIL.length,
            attachments: [],
            route: "new",
            job: null,
        }),
    );
    const { job } = await ctx.jobStore.insertJob({
        letter: "E",
        requestText: "mail",
        origin: { kind: "request", wayIn: "email" },
        email: { account, savedId: saved.id, messageId },
        leadStart: {},
    });
    await ctx.jobStore.writeMail((tx) => tx.recordIntakeOutcome(saved.id, { outcome: "job_created", job: job.id }));
    await ctx.jobStore.applyAction(job.id, "start", {}, { kind: "daemon" });
    return job;
}

/** Completes the job with a result reply owed to the sender, as the completion action commits it. */
async function completeWithReply(
    rig: Rig,
    ctx: ServiceContext,
    job: Job,
    account: string,
    text: string,
): Promise<void> {
    const policy = createMailPolicy({
        jobStore: ctx.jobStore,
        accounts: () => [accountOf(rig, account)],
        notice: () => undefined,
        mailDir: ctx.dirs.mailDir,
    });
    await ctx.jobStore.setRequestMark(job.id, true, teamMember);
    await ctx.jobStore.updateFields(job.id, { definitionOfDone: "Answered" }, teamMember);
    const current = await ctx.jobStore.getJob(job.id);
    const decision = await policy.forComplete({ job: current, author: lead, mailText: text });
    assert.equal(decision.kind, "owe");
    const owedMail = decision.kind === "owe" ? decision.row : undefined;
    await ctx.jobStore.applyAction(
        job.id,
        "complete",
        { justification: "the internal justification", ...(owedMail && { owedMail }) },
        lead,
    );
}

/** Starts a child daemon on the rig's directories; it kills itself with `SIGKILL` at `mailCrashAt` when given. */
async function startChild(rig: Rig, mailCrashAt?: MailWritePoint): Promise<DaemonProcess> {
    await rm(join(rig.env.piAgentDir, "settings.json"), { force: true });
    const child = startChildDaemon({
        hermetic: { ...rig.env, env: { ...rig.env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
        mailClock: CLOCK_START,
        ...(mailCrashAt !== undefined && { mailCrashAt }),
    });
    children.push(child);
    await child.ready;
    return child;
}

async function untilKilled(child: DaemonProcess): Promise<void> {
    // The timer is cancelled once the child exits, or it would hold the test process open for the whole wait.
    const timer = new AbortController();
    const timeout = sleep(WAIT_MS, "timeout" as const, { signal: timer.signal }).catch(() => undefined);
    const outcome = await Promise.race([child.exited, timeout]);
    timer.abort();
    assert.notEqual(outcome, "timeout", "the daemon was never killed");
    assert.equal((outcome as { signal: string | null }).signal, "SIGKILL");
}

const rowsIn = (ctx: ServiceContext, state: OutboxState): Promise<OutboxRow[]> =>
    ctx.jobStore.readMail((tx) => tx.rowsInState(state));

async function mailHistory(ctx: ServiceContext, job: Job): Promise<{ mail: string; [field: string]: unknown }[]> {
    const { entries } = await ctx.jobStore.listHistory(job.id, {});
    return entries.filter((entry) => entry.field === "mail").map((entry) => entry.new as never);
}

describe("the mail repair at startup", () => {
    it("never sends a row left sending and says in the job's history that it may not have gone out (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startRig(["work"]);
        const seed = await startDaemon(rig, false);
        const cut = await emailJob(seed.ctx, "work");
        await completeWithReply(rig, seed.ctx, cut, "work", "Cut short.");
        // The marker is owed after the row that is cut short, so a sender that took that row would take it first.
        const marker = await emailJob(seed.ctx, "work");
        await completeWithReply(rig, seed.ctx, marker, "work", "Marker.");
        await stopDaemon(seed);
        await writeConfig(rig, ["work"]);
        await untilKilled(await startChild(rig, "mail-sending"));
        assert.equal(rig.server.received().length, 0);

        const started = await startDaemon(rig, true);
        await untilTrue("the marker to be sent", async () => (await rowsIn(started.ctx, "sent")).length === 1);

        assert.equal(rig.server.received().length, 1);
        assert.equal((await rowsIn(started.ctx, "may_not_have_gone_out")).length, 1);
        const history = (await mailHistory(started.ctx, cut)).map((entry) => entry.mail);
        assert.deepEqual(history, ["may_not_have_gone_out"]);
    });

    it("sends once a reply owed whose sending never began (AC-2)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startRig(["work"]);
        const seed = await startDaemon(rig, false);
        const job = await emailJob(seed.ctx, "work");
        await completeWithReply(rig, seed.ctx, job, "work", "All done.");
        await stopDaemon(seed);
        await writeConfig(rig, ["work"]);
        // The paused server keeps the account from being ready, so the killed daemon never began to send.
        rig.server.pause();
        const child = await startChild(rig);
        child.kill9();
        await untilKilled(child);
        rig.server.resume();

        const started = await startDaemon(rig, true);
        await untilTrue("the reply to be sent", async () => (await rowsIn(started.ctx, "sent")).length === 1);

        assert.equal(rig.server.received().length, 1);
        assert.deepEqual(
            (await mailHistory(started.ctx, job)).map((entry) => entry.mail),
            ["sent"],
        );
    });

    it("removes the intake row of a removed account, turns its owed rows account_removed and never sends them (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        // The fake server knows only `work`; `other` stays configured and fails its login, which this test ignores.
        const rig = await startRig(["work"]);
        const seed = await startDaemon(rig, false);
        const job = await emailJob(seed.ctx, "work");
        await completeWithReply(rig, seed.ctx, job, "work", "Never goes out.");
        const identityOf = (name: string) => JSON.stringify(["127.0.0.1", address(name), address(name)]);
        await seed.ctx.jobStore.writeMail(async (tx) => {
            await tx.writeIntake("work", { uidvalidity: 1, nextUid: 5, identity: identityOf("work") });
            await tx.writeIntake("other", { uidvalidity: 1, nextUid: 5, identity: identityOf("other") });
        });
        await stopDaemon(seed);
        await writeConfig(rig, ["other"]);

        const without = await startDaemon(rig, true);

        const [removed] = await rowsIn(without.ctx, "account_removed");
        assert.equal(removed?.account, "work");
        assert.equal((await rowsIn(without.ctx, "owed")).length, 0);
        assert.equal(await without.ctx.jobStore.readMail((tx) => tx.readIntake("work")), undefined);
        assert.notEqual(await without.ctx.jobStore.readMail((tx) => tx.readIntake("other")), undefined);
        const entry = (await mailHistory(without.ctx, job)).find((each) => each.mail === "account_removed");
        assert.equal(entry?.from, address("work"));
        assert.deepEqual(entry?.to, [SENDER]);
        await stopDaemon(without);

        await writeConfig(rig, ["other", "work"]);
        const added = await startDaemon(rig, true);
        await untilReady(added, "work");
        const later = await emailJob(added.ctx, "work");
        await completeWithReply(rig, added.ctx, later, "work", "Goes out.");
        await added.mail?.control.restartAccount("work");
        await untilTrue("the new reply to be sent", async () => (await rowsIn(added.ctx, "sent")).length === 1);

        assert.equal(rig.server.received().length, 1);
        assert.equal((await rowsIn(added.ctx, "account_removed")).length, 1);
        assert.equal((await rowsIn(added.ctx, "owed")).length, 0);
    });

    it("writes a saved email's copy again when its folder is missing, identical to a first write (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startRig(["work"]);
        const seed = await startDaemon(rig, false);
        const job = await emailJob(seed.ctx, "work");
        const [email] = await seed.ctx.jobStore.readMail((tx) => tx.emailRowsOf(job.id));
        const savedId = (email as { id: string }).id;
        const mailDir = seed.ctx.dirs.mailDir;
        assert.equal(await hasSavedCopy(mailDir, savedId), false);
        await stopDaemon(seed);
        await writeConfig(rig, ["work"]);

        const started = await startDaemon(rig, true);

        assert.equal(await hasSavedCopy(mailDir, savedId), true);
        assert.equal(await readFile(join(mailDir, savedId, "message.eml"), "utf8"), RAW_EMAIL);
        const reference = `${mailDir}-reference`;
        await writeSavedCopy(reference, savedId, Buffer.from(RAW_EMAIL));
        assert.equal(
            await readFile(join(mailDir, savedId, "message.txt"), "utf8"),
            await readFile(join(reference, savedId, "message.txt"), "utf8"),
        );
        assert.equal(started.ctx.dirs.mailDir, mailDir);
    });
});
