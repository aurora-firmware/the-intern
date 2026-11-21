/**
 * OAuth token refresh and a revoked sign-in on the mail rig (T-440, S-009 REQ-004, REQ-005): an account that signed in
 * keeps its access token fresh across several token lifetimes and a restart, a revoked refresh token turns it
 * `needs_sign_in` and pauses its intake while another account goes on, and a finished sign-in starts intake.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(90_000);
const WAIT_BOUND_MS = scaled(20_000);
const POLL_INTERVAL_MS = 20;
const OWNED_ADDRESS = "intern@example.test";
const OTHER_ADDRESS = "other@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret-pw";
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const DEVICE_POLL_STEP_MS = 10_000;
const TOKEN_LIFETIME_MS = 3600 * 1000;
const BEYOND_EXPIRY_MS = 2 * TOKEN_LIFETIME_MS;
// Past the longest retry pause (30 minutes) and inside the token's lifetime less its refresh margin.
const RETRY_STEP_MS = 31 * 60 * 1000;
const REFRESH_ROUNDS = 3;
const REVOKED_MESSAGE = "The refresh token was revoked.";

type TestResult = { imap: { ok: boolean; message?: string }; smtp?: { ok: boolean; message?: string } };
type SignInStart = { code: string };
type AccountView = { name: string; status: string; lastError?: { message: string } };
type Secret = { accessToken?: string; refreshToken?: string };
type Job = { request: { text: string } };

const rigs: MailRig[] = [];
const servers: FakeMailServer[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
    for (const server of servers.splice(0)) await server.stop();
});

async function start(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [], clockStart: new Date(CLOCK_START) });
    rigs.push(rig);
    rig.server.addAccount({ address: OWNED_ADDRESS, login: OWNED_ADDRESS, password: PASSWORD });
    return rig;
}

async function storedSecret(rig: MailRig, name: string): Promise<Secret> {
    const file = join(rig.env.stateDir, "secrets", "mail", `${name}.json`);
    try {
        return JSON.parse(await readFile(file, "utf8")) as Secret;
    } catch {
        return {};
    }
}

async function until<T>(description: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function account(rig: MailRig, name: string): Promise<AccountView> {
    const { accounts } = (await rig.process().invoke("mail.accounts.list", {})) as { accounts: AccountView[] };
    return accounts.find((candidate) => candidate.name === name) as AccountView;
}

const refreshRequests = (rig: MailRig) => rig.oauth.requests().filter((r) => r.body.grant_type === "refresh_token");

/** The fake server accepts the access token the daemon stored once the test tells it the token. */
const acceptStoredToken = async (rig: MailRig, name: string): Promise<void> => {
    const token = await until("the access token to be stored", async () => (await storedSecret(rig, name)).accessToken);
    rig.server.acceptToken(OWNED_ADDRESS, token);
};

async function createMicrosoftAccount(rig: MailRig, name: string): Promise<void> {
    await rig.process().invoke("mail.accounts.create", {
        name,
        kind: "owned",
        address: OWNED_ADDRESS,
        imap_host: "127.0.0.1",
        imap_port: rig.server.imapPort,
        imap_security: "none",
        smtp_host: "127.0.0.1",
        smtp_port: rig.server.smtpPort,
        smtp_security: "none",
        auth: "microsoft",
        client_id: "client-1",
        tenant: "contoso",
    });
}

const intakeWatching = (rig: MailRig, name: string) =>
    until(`intake of ${name} to watch the inbox`, () =>
        new RegExp(`mail intake watching.*account=${name}`).test(rig.process().stderr()) ? true : undefined,
    );

/** Signs the account in through the device code flow and returns once it is `ready` and intake watches, with the clock's moment. */
async function signIn(rig: MailRig, name: string): Promise<number> {
    const started = (await rig.process().invoke("mail.accounts.signin", { name })) as SignInStart;
    rig.oauth.enterCode(started.code);
    let clock = CLOCK_START + DEVICE_POLL_STEP_MS;
    await rig.setClock(new Date(clock));
    await until("the first access token to be stored", async () => (await storedSecret(rig, name)).accessToken);
    await acceptStoredToken(rig, name);
    await until(`account ${name} to be ready`, async () => {
        const { status } = await account(rig, name);
        if (status === "ready") return true;
        if (status !== "failing") return undefined;
        clock += RETRY_STEP_MS;
        await rig.setClock(new Date(clock));
        return undefined;
    });
    await intakeWatching(rig, name);
    return clock;
}

const rawMail = (to: string, subject: string): string =>
    `From: ${SENDER}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n\r\nbody\r\n`;

const jobsOf = async (rig: MailRig): Promise<Job[]> =>
    ((await rig.process().invoke("jobs.list", {})) as { jobs: Job[] }).jobs;

describe("OAuth token refresh with nobody present (S-009 AC-004.2)", () => {
    it("keeps the account ready over several token lifetimes and a restart, and uses the newest refresh token", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        await createMicrosoftAccount(rig, "work");
        let clock = await signIn(rig, "work");

        /** One token lifetime later the access token is stale, so a connection test refreshes it. */
        async function refreshOnce(): Promise<{ spent: string }> {
            const before = (await storedSecret(rig, "work")).refreshToken as string;
            const requestsBefore = refreshRequests(rig).length;
            clock += BEYOND_EXPIRY_MS;
            await rig.setClock(new Date(clock));
            await rig.process().invoke("mail.accounts.test", { name: "work" });
            await acceptStoredToken(rig, "work");
            const result = (await rig.process().invoke("mail.accounts.test", { name: "work" })) as TestResult;
            const issued = (await storedSecret(rig, "work")).refreshToken as string;
            assert.deepEqual(result, { imap: { ok: true }, smtp: { ok: true } });
            assert.equal(refreshRequests(rig).length, requestsBefore + 1);
            assert.equal(refreshRequests(rig).at(-1)?.body.refresh_token, before);
            assert.notEqual(issued, before);
            assert.equal((await account(rig, "work")).status, "ready");
            return { spent: before };
        }

        const spent: string[] = [];
        for (let round = 0; round < REFRESH_ROUNDS; round++) spent.push((await refreshOnce()).spent);
        const newest = (await storedSecret(rig, "work")).refreshToken as string;
        await rig.restart();
        await rig.waitForStatus("work", "ready");
        await intakeWatching(rig, "work");
        const afterRestart = await refreshOnce();

        assert.equal(new Set([...spent, newest]).size, REFRESH_ROUNDS + 1);
        assert.equal(afterRestart.spent, newest);
    });
});

describe("a revoked sign-in (S-009 AC-004.3, REQ-005)", () => {
    it("turns the account needs_sign_in with the provider's message and pauses its intake while another account goes on", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        await createMicrosoftAccount(rig, "work");
        const clock = await signIn(rig, "work");
        await intakeWatching(rig, "work");
        const otherServer = await startFakeMailServer();
        servers.push(otherServer);
        otherServer.addAccount({ address: OTHER_ADDRESS, login: OTHER_ADDRESS, password: PASSWORD });
        await rig.process().invoke("mail.accounts.create", {
            name: "other",
            kind: "owned",
            address: OTHER_ADDRESS,
            imap_host: "127.0.0.1",
            imap_port: otherServer.imapPort,
            imap_security: "none",
            smtp_host: "127.0.0.1",
            smtp_port: otherServer.smtpPort,
            smtp_security: "none",
            auth: "password",
            password: PASSWORD,
        });
        await rig.waitForStatus("other", "ready");
        await intakeWatching(rig, "other");

        rig.oauth.revoke((await storedSecret(rig, "work")).refreshToken as string);
        await rig.setClock(new Date(clock + BEYOND_EXPIRY_MS));
        await rig.process().invoke("mail.accounts.change", { name: "work", check_interval_seconds: 120 });
        await rig.waitForStatus("work", "needs_sign_in");

        assert.equal((await account(rig, "work")).lastError?.message, REVOKED_MESSAGE);
        rig.deliver(OWNED_ADDRESS, rawMail(OWNED_ADDRESS, "for the revoked account"));
        otherServer.deliver(OTHER_ADDRESS, rawMail(OTHER_ADDRESS, "for the other account"));
        await until("the other account's mail to become a job", async () =>
            (await jobsOf(rig)).find((job) => /Subject: for the other account/.test(job.request.text)),
        );
        assert.equal(
            (await jobsOf(rig)).some((job) => /Subject: for the revoked account/.test(job.request.text)),
            false,
        );
        assert.equal((await account(rig, "work")).status, "needs_sign_in");
        assert.equal((await account(rig, "other")).status, "ready");
    });
});

describe("intake after a sign-in (S-009 AC-004.1)", () => {
    it("starts when a microsoft account finishes signing in, and a new email becomes a triage job", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        await createMicrosoftAccount(rig, "work");
        assert.equal((await account(rig, "work")).status, "needs_sign_in");
        await signIn(rig, "work");
        await intakeWatching(rig, "work");

        rig.deliver(OWNED_ADDRESS, rawMail(OWNED_ADDRESS, "after the sign in"));

        const job = await rig.waitForJob((candidate) =>
            /Subject: after the sign in/.test((candidate as unknown as Job).request.text),
        );
        assert.match((job as unknown as Job).request.text, /Subject: after the sign in/);
    });
});
