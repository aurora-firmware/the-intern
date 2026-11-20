/**
 * What intake does about time and starting points (S-009 REQ-023, REQ-003, REQ-021, REQ-010, REQ-007; S-007 v0.6
 * REQ-014), on the mail rig: the check interval and IDLE, the start after a change of the account's identity, a changed
 * UIDVALIDITY, a monitored account and an email without a `Message-ID`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
// REQ-023's bound, scaled for a loaded machine only as a safety net: IDLE's own restart (15 s) must not meet it.
const ANNOUNCED_MAIL_BOUND_MS = scaled(10_000);
const CHECK_INTERVAL_MS = 60_000;
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";
// The same loopback address as `127.0.0.1`, written so the account's identity differs.
const OTHER_IMAP_HOST = "127.1";

type Job = { id: string; request: { text: string } };

const rigs: MailRig[] = [];
const servers: FakeMailServer[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
    for (const server of servers.splice(0)) await server.stop();
});

async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

const rawMail = (subject: string, headers: string[] = [], to = ADDRESS): string =>
    `From: ${SENDER}\r\nTo: ${to}\r\nSubject: ${subject}\r\n${headers.map((header) => `${header}\r\n`).join("")}\r\nbody\r\n`;
const withId = (subject: string, headers: string[] = [], to = ADDRESS): string =>
    rawMail(subject, [`Message-ID: <${subject.replaceAll(" ", "-")}@example.test>`, ...headers], to);

const subjectOf = (job: Job): string | undefined => /Subject: (.*)/.exec(job.request.text)?.[1];
const jobsOf = async (rig: MailRig): Promise<Job[]> =>
    ((await rig.process().invoke("jobs.list", {})) as { jobs: Job[] }).jobs;
const watching = (rig: MailRig, count = 1) =>
    until("intake to watch the inbox", () =>
        rig.process().stderr().split("mail intake watching").length > count ? true : undefined,
    );
const forSubject = (subject: string) => (job: object) => subjectOf(job as Job) === subject;

async function startServer(options: Parameters<typeof startFakeMailServer>[0] = {}): Promise<FakeMailServer> {
    const server = await startFakeMailServer(options);
    servers.push(server);
    server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    return server;
}

async function startRig(accounts: Parameters<typeof startMailRig>[0]["accounts"]): Promise<MailRig> {
    const rig = await startMailRig({ accounts });
    rigs.push(rig);
    return rig;
}

const ownedAccount = (name: string, address: string) => ({ name, address, password: PASSWORD });

/** Puts an account on the rig's daemon, pointing at the server, as `mail.accounts.create` takes it. */
function createAccount(rig: MailRig, server: FakeMailServer, kind: "owned" | "monitored", name = "work") {
    const smtp =
        kind === "owned" ? { smtp_host: "127.0.0.1", smtp_port: server.smtpPort, smtp_security: "none" } : undefined;
    return rig.process().invoke("mail.accounts.create", {
        name,
        kind,
        address: ADDRESS,
        imap_host: "127.0.0.1",
        imap_port: server.imapPort,
        imap_security: "none",
        ...smtp,
        auth: "password",
        password: PASSWORD,
    });
}

async function lastErrorOf(rig: MailRig, name: string): Promise<string> {
    return until("the account's last error", async () => {
        const status = (await rig.process().invoke("daemon.status", {})) as {
            mailAccounts: { name: string; lastError?: { message: string } }[];
        };
        return status.mailAccounts.find((account) => account.name === name)?.lastError?.message;
    });
}

describe("intake's timeliness and starting points", () => {
    it("takes an email in once the clock moves by the interval on a server without IDLE, and within 10 seconds on one with IDLE (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const polled = await startServer({ idle: false });
        const rig = await startRig([]);
        await createAccount(rig, polled, "owned");
        await rig.waitForStatus("work", "ready");
        await watching(rig);
        polled.deliver(ADDRESS, withId("polled", []));
        await rig.setClock(new Date(CLOCK_START + CHECK_INTERVAL_MS));
        await rig.waitForJob(forSubject("polled"));

        const announced = await startServer();
        await createAccount(rig, announced, "owned", "announced");
        await rig.waitForStatus("announced", "ready");
        await watching(rig, 2);
        announced.deliver(ADDRESS, withId("announced"));
        await rig.waitForJob(forSubject("announced"), { timeoutMs: ANNOUNCED_MAIL_BOUND_MS });
    });

    it("creates no job and gives no input for a reply arriving in a monitored account (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startRig([]);
        const monitored = await startServer();
        const owned = await startServer();
        await createAccount(rig, monitored, "monitored", "watch");
        await rig.waitForStatus("watch", "ready");
        // The owned account starts after the monitored one, so a monitored intake, were there one, has recorded its
        // starting point by the time the owned one watches; the owned inbox's job then comes after the reply.
        await createAccount(rig, owned, "owned");
        await rig.waitForStatus("work", "ready");
        await watching(rig);
        monitored.deliver(ADDRESS, withId("question"));
        monitored.deliver(ADDRESS, withId("Re: question", ["In-Reply-To: <question@example.test>"]));
        owned.deliver(ADDRESS, withId("marker"));
        const marker = await rig.waitForJob(forSubject("marker"));
        await until("the marker job to block", async () => {
            const job = (await rig.process().invoke("jobs.get", { job: marker.id })) as { status: string };
            return job.status === "blocked" ? true : undefined;
        });
        assert.deepEqual((await jobsOf(rig)).map(subjectOf), ["marker"]);
        const status = (await rig.process().invoke("daemon.status", {})) as {
            mailAccounts: { name: string; status: string; lastError?: unknown }[];
        };
        const watch = status.mailAccounts.find((account) => account.name === "watch");
        assert.deepEqual([watch?.status, watch?.lastError], ["ready", undefined]);
        assert.deepEqual(monitored.received(), []);
    });

    it("leaves the mail present at the next connection alone after a new imap_host (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        // A server without IDLE, so the first connection takes nothing until the clock moves and `present` waits.
        const polled = await startServer({ idle: false });
        const rig = await startRig([]);
        await createAccount(rig, polled, "owned");
        await rig.waitForStatus("work", "ready");
        await watching(rig);
        polled.deliver(ADDRESS, withId("present"));
        await rig.process().invoke("mail.accounts.change", { name: "work", imap_host: OTHER_IMAP_HOST });
        await rig.waitForStatus("work", "ready");
        await watching(rig, 2);
        polled.deliver(ADDRESS, withId("later"));
        await rig.setClock(new Date(CLOCK_START + CHECK_INTERVAL_MS));
        await rig.waitForJob(forSubject("later"));
        assert.deepEqual((await jobsOf(rig)).map(subjectOf), ["later"]);
    });

    it("takes in none of the mail present at a changed UIDVALIDITY, says so in the last error and takes later mail (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startRig([ownedAccount("work", ADDRESS)]);
        await rig.waitForStatus("work", "ready");
        await watching(rig);
        rig.process().kill9();
        await rig.process().exited;
        rig.server.setUidValidity(ADDRESS, 4242);
        rig.deliver(ADDRESS, withId("lost"));
        await rig.restart();
        assert.match(await lastErrorOf(rig, "work"), /could no longer tell old mail from new/);
        await watching(rig);
        rig.deliver(ADDRESS, withId("found"));
        await rig.waitForJob(forSubject("found"));
        assert.deepEqual((await jobsOf(rig)).map(subjectOf), ["found"]);
    });

    it("creates one triage job for an email without a Message-ID (AC-5)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startRig([ownedAccount("work", ADDRESS)]);
        await rig.waitForStatus("work", "ready");
        await watching(rig);
        rig.deliver(ADDRESS, rawMail("anonymous"));
        await rig.waitForJob(forSubject("anonymous"));
        rig.deliver(ADDRESS, withId("marker"));
        await rig.waitForJob(forSubject("marker"));
        assert.deepEqual((await jobsOf(rig)).map(subjectOf).toSorted(), ["anonymous", "marker"]);
    });
});
