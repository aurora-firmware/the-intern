/**
 * Intake (S-009 REQ-006, REQ-007, REQ-009, REQ-021, REQ-023): each new email of an owned inbox becomes a triage job or
 * input to the open job of its thread, on the mail rig and, for the status deltas, in a daemon of this process.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentsComponent } from "../../src/agents/agents_component.ts";
import { runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { JobsComponent } from "../../src/jobs/jobs_component.ts";
import { type MessageRef, openImap } from "../../src/mail/imap_client.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import { composeMessage } from "../../src/mail/mime.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { createTestClock, type TestClock } from "../support/schedule_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";
const AFTER_RETRY_PAUSE = "2026-03-02T11:00:00.000Z";
const EXISTING_MESSAGES = 5000;
// REQ-023's bound, unscaled: the library's own IDLE restart (15 s) must not meet it.
const ANNOUNCED_MAIL_BOUND_MS = 10_000;
const CHECK_INTERVAL_MS = 60_000;

type Entry = { field: string; old: unknown; new: unknown };
type Job = { id: string; leadConversation?: string; number: string; status: string; related: string[] } & {
    request: { text: string; origin: unknown };
};

const scenario = (name: string, run: () => Promise<void>) => it(name, { timeout: TEST_TIMEOUT_MS }, run);

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const jobsOf = async (rig: MailRig) =>
    ((await rig.process().invoke("jobs.list", {})) as { jobs: Job[] }).jobs.toSorted((a, b) =>
        a.number < b.number ? -1 : 1,
    );

/** Starts the rig with the account unknown to the server, so it first connects once the test has filled the inbox. */
async function startWatching(existing: (server: FakeMailServer) => void = () => undefined): Promise<MailRig> {
    const account = { name: "work", address: ADDRESS, password: PASSWORD, isKnownToServer: false };
    const rig = await startMailRig({ accounts: [account] });
    cleanups.push(() => rig.stop());
    await rig.waitForStatus("work", "failing");
    rig.server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    existing(rig.server);
    await rig.setClock(new Date(AFTER_RETRY_PAUSE));
    await rig.waitForStatus("work", "ready");
    await watching(rig);
    return rig;
}

const logged = (rig: MailRig) => rig.process().stderr().includes("mail intake watching") || undefined;
const watching = (rig: MailRig) => until("intake to watch the inbox", () => logged(rig));

const jobOf = async (rig: MailRig, job?: Job) => (await rig.process().invoke("jobs.get", { job: job?.id })) as Job;

const untilBlocked = (rig: MailRig, job?: Job) =>
    until("the job to block", async () => ((await jobOf(rig, job)).status === "blocked" ? true : undefined));

const untilJobs = (rig: MailRig, count: number) =>
    until(`${count} jobs`, async () => ((await jobsOf(rig)).length >= count ? await jobsOf(rig) : undefined));

const rawMail = (subject: string, text: string, headers: string[] = []): string =>
    `From: ${SENDER}\r\nTo: ${ADDRESS}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n` +
    `${headers.map((header) => `${header}\r\n`).join("")}\r\n${text}\r\n`;

const accountToml = (server: FakeMailServer, address = ADDRESS) =>
    ["[[mail_account]]", 'name = "work"', 'kind = "owned"', `address = "${address}"`, `login = "${ADDRESS}"`]
        .concat('imap_host = "127.0.0.1"', `imap_port = ${server.imapPort}`, 'imap_security = "none"')
        .concat('auth = "password_command"', `password_command = ["printf", "%s", "${PASSWORD}"]`, "")
        .join("\n");

/** A fake server with the account's mailbox, the account in the instance's config, and a mail clock. */
async function setUp() {
    const env = await createHermeticEnv();
    const server = await startFakeMailServer();
    cleanups.push(() => env.dispose());
    cleanups.push(() => server.stop());
    server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    await writeFile(join(env.configDir, "config.toml"), accountToml(server));
    return { env, server, clock: createTestClock(new Date(AFTER_RETRY_PAUSE)) };
}

/** The mail component alone in a daemon of this process, with the hub's status changes recorded. */
async function runMail(env: HermeticEnv, clock: TestClock, points: string[] = []) {
    const log: string[] = [];
    const logger = createLogger({ stream: { write: (chunk: string) => log.push(chunk) > 0 } });
    const catalog = { addReferenceSource() {}, get: () => ({}) };
    const [agents, jobs] = [{ runtime: () => ({ catalog }) }, { options: {} }] as unknown as [
        AgentsComponent,
        JobsComponent,
    ];
    const mail = await createMailComponent({
        clock,
        agents,
        jobs,
        logger,
        afterWrite: async (point) => void points.push(point),
    });
    const statuses: string[] = [];
    mail.accountStatus.onChange((view) => statuses.push(view.status));
    const contexts: ServiceContext[] = [];
    const { configDir, stateDir, dataDir, runtimeDir } = env;
    const daemon = runDaemon({
        flags: { configDir, stateDir, dataDir, runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: mail.sections,
        components: [mail.component, { name: "probe", start: async (ctx) => void contexts.push(ctx) }],
        operations: mail.operations,
        accountStatus: mail.accountStatus,
    });
    cleanups.push(() => daemon.stop());
    await until("intake to watch the inbox", () => (log.join("").includes("mail intake watching") ? true : undefined));
    return { mail, statuses, daemon, ctx: contexts[0] as ServiceContext };
}

describe("intake", () => {
    scenario(
        "takes only mail arriving after the start, the second within 10 seconds of the first (AC-1, AC-6)",
        async () => {
            const rig = await startWatching((server) => {
                for (let n = 0; n < EXISTING_MESSAGES; n++) server.deliver(ADDRESS, rawMail(`old ${n}`, "old"));
            });
            rig.deliver(ADDRESS, rawMail("new one", "hello"));
            await rig.waitForJob(() => true);
            const jobs = await jobsOf(rig);
            assert.equal(jobs.length, 1);
            assert.match(jobs[0]?.request.text ?? "", /Subject: new one/);
            rig.deliver(ADDRESS, rawMail("two", "second"));
            await rig.waitForJob((job) => job.id !== jobs[0]?.id, { timeoutMs: ANNOUNCED_MAIL_BOUND_MS });
        },
    );

    scenario("makes one job for an email, an auto-reply, a failure report and a list message (AC-2)", async () => {
        const rig = await startWatching();
        const subjects = ["ordinary", "out of office", "delivery failure", "list message"];
        const headers = ["Auto-Submitted: auto-replied", "Precedence: bounce", "List-Id: <l.test>"];
        for (const [n, s] of subjects.entries()) rig.deliver(ADDRESS, rawMail(s, "body", headers.slice(n - 1, n)));
        const jobs = await untilJobs(rig, subjects.length);
        const taken = jobs.map((job) => /Subject: (.*)/.exec(job.request.text)?.[1]);
        assert.deepEqual(taken.toSorted(), subjects.toSorted());
        assert.deepEqual(rig.server.received(), []);
    });

    scenario(
        "sets the last error, status staying ready, on a UIDVALIDITY change; new identity starts afresh (AC-7)",
        async () => {
            const { env, server, clock } = await setUp();
            const first = await runMail(env, clock);
            await first.daemon.stop();
            server.setUidValidity(ADDRESS, 4242);
            server.deliver(ADDRESS, rawMail("lost", "body"));
            const second = await runMail(env, clock);
            const lastError = await until(
                "the last error",
                () => second.mail.accountStatus.get("mail", "work")?.lastError,
            );
            assert.match(lastError.message, /could no longer tell old mail from new/);
            assert.deepEqual(new Set(second.statuses.slice(second.statuses.indexOf("ready"))), new Set(["ready"]));
            assert.deepEqual((await second.ctx.jobStore.listJobs({})).jobs, []);
            await second.daemon.stop();
            server.deliver(ADDRESS, rawMail("before", "body"));
            await writeFile(join(env.configDir, "config.toml"), accountToml(server, "other@example.test"));
            const points: string[] = [];
            await runMail(env, clock, points);
            assert.deepEqual(points, []);
        },
    );

    scenario("checks the inbox again at every check interval of the clock (AC-023.1)", async () => {
        const { env, clock } = await setUp();
        const waits: Date[] = [];
        const spy = {
            ...clock,
            wait: (until: Date, signal: AbortSignal) => {
                waits.push(until);
                return clock.wait(until, signal);
            },
        };
        await runMail(env, spy);
        assert.equal((waits[0]?.getTime() ?? 0) - Date.parse(AFTER_RETRY_PAUSE), CHECK_INTERVAL_MS);
        clock.advance(CHECK_INTERVAL_MS);
        await until("the check after the interval to end", () => (waits.length === 2 ? true : undefined));
    });

    scenario("saves the message and its attachments and leaves the message in INBOX unflagged (AC-3)", async () => {
        const rig = await startWatching();
        const pdf = Buffer.from(Array.from({ length: 10_240 }, (_, index) => (index * 31 + 7) % 256));
        const note = Buffer.from("remember the milk");
        const attachments = [
            { filename: "report.pdf", contentType: "application/pdf", content: pdf },
            { filename: "note.txt", contentType: "text/plain", content: note },
        ];
        const sent = await composeMessage({ from: SENDER, to: [ADDRESS], subject: "files", text: "see", attachments });
        rig.deliver(ADDRESS, sent.raw);
        const [job] = await untilJobs(rig, 1);
        assert.deepEqual(job?.request.origin, {
            kind: "request",
            wayIn: "email",
            observed: { account: "work", messageId: sent.messageId, sender: SENDER },
        });
        const conversationId = (await jobOf(rig, job)).leadConversation;
        const lead = await rig.process().invoke("conversations.get", { conversationId });
        assert.equal((lead as { seat: { role: string } }).seat.role, "triage");
        const paths = [...(job?.request.text.matchAll(/^(?:Saved message: |- )(\/.+)$/gm) ?? [])].map((m) => m[1]);
        assert.equal(paths.length, 3);
        const [message, ...saved] = await Promise.all(paths.map((path) => readFile(path as string)));
        assert.deepEqual(message, sent.raw);
        assert.deepEqual(saved, [pdf, note]);
        const [stored] = rig.server.mailbox(ADDRESS, "INBOX");
        assert.deepEqual([stored?.flags, stored?.raw], [[], sent.raw]);
    });

    scenario("relates a Done job's reply to it, and an unthreaded quote of the reply to nothing (AC-4)", async () => {
        const rig = await startWatching();
        rig.deliver(ADDRESS, rawMail("first", "please file this"));
        const [first] = await untilJobs(rig, 1);
        await untilBlocked(rig, first);
        await rig.process().invoke("jobs.cancel", { job: first?.id, justification: "not needed" });
        rig.deliver(ADDRESS, rawMail("Re: first", "one more thing", ["In-Reply-To: <first@example.test>"]));
        const [, reply] = await untilJobs(rig, 2);
        rig.deliver(ADDRESS, rawMail("Re: Re: first", "> one more thing\r\n\r\nand again"));
        const [, , quote] = await untilJobs(rig, 3);
        assert.deepEqual(reply?.related, [first?.number]);
        assert.deepEqual(quote?.related, []);
        const after = await jobOf(rig, first);
        assert.equal(after.status, "done");
        assert.deepEqual(after.related, [reply?.number]);
    });

    scenario("delivers a reply in a Blocked job's thread to its lead as input and resumes the job (AC-5)", async () => {
        const rig = await startWatching();
        rig.deliver(ADDRESS, rawMail("question", "please file this"));
        const [job] = await untilJobs(rig, 1);
        await untilBlocked(rig, job);
        const lead = (await jobOf(rig, job)).leadConversation;
        rig.deliver(ADDRESS, rawMail("Re: question", "use the staging one", ["In-Reply-To: <question@example.test>"]));
        const history = () =>
            rig.process().invoke("jobs.history.list", { job: job?.id, limit: 100 }) as Promise<{ entries: Entry[] }>;
        const { entries } = await until("the reply to be recorded", async () => {
            const page = await history();
            return page.entries.filter((entry) => entry.field === "mail").length === 2 ? page : undefined;
        });
        const resumed = entries.some((e) => e.field === "status" && e.old === "blocked" && e.new === "in_progress");
        assert.ok(resumed, "the job resumed");
        const read = await rig.process().invoke("conversations.entries", { conversationId: lead, limit: 500 });
        type Steer = { kind: string; data: { actor: unknown; content: string } };
        const [steer] = (read as { entries: Steer[] }).entries.filter((entry) => entry.kind === "intern.steer");
        assert.deepEqual(steer?.data.actor, { kind: "team_member", wayIn: "email" });
        assert.match(steer?.data.content ?? "", /From: ann@example\.test[\s\S]*use the staging one/);
        assert.equal((await jobsOf(rig)).length, 1);
    });

    scenario("takes mail that arrived while down in order, passing over a vanished UID (REQ-021)", async () => {
        const rig = await startWatching();
        rig.process().kill9();
        await rig.process().exited;
        for (const subject of ["a", "b", "c"]) rig.deliver(ADDRESS, rawMail(subject, "body"));
        const connection = { host: "127.0.0.1", port: rig.server.imapPort, security: "none", idleSeconds: 60 } as const;
        const imap = await openImap({ ...connection, credential: { user: ADDRESS, password: PASSWORD } });
        const [ref] = await imap.search("INBOX", { subject: "b" }, 1);
        await imap.move([ref as MessageRef], "Trash");
        await imap.logout();
        await rig.restart();
        const jobs = await untilJobs(rig, 2);
        const subjects = jobs.map((job) => /Subject: (.*)/.exec(job.request.text)?.[1]);
        assert.deepEqual(subjects, ["a", "c"]);
    });
});
