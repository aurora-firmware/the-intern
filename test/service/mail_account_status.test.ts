/**
 * The mail account status through an outage, a slow server and failed logins (T-441, S-009 REQ-005, REQ-001, REQ-004):
 * an account whose server stops answering turns `failing`, retries at growing pauses and returns to `ready` while
 * another account goes on; a slow server keeps an account `connecting`; a certificate that doesn't verify and a failing
 * password command turn an account `failing` with the reason. The mail component runs on a clock the test moves, so the
 * retry times are read from the account's last check.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { startDaemon } from "../support/daemon_process.ts";
import { type FakeMailServer, startFakeMailServer, TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { type FeedDelta, type FeedWatch, watchFeed } from "../support/feed_watch.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

// A server that holds a connection fails the product's check after its own 30 seconds of real time, so each failing
// check of the outage test takes that long whatever the scale.
const OUTAGE_TEST_TIMEOUT_MS = scaled(300_000);
const TEST_TIMEOUT_MS = scaled(60_000);
const FAILURE_BOUND_MS = scaled(90_000);
const WAIT_BOUND_MS = scaled(20_000);
const POLL_INTERVAL_MS = 10;
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const CHECK_INTERVAL_SECONDS = 600;
const SECOND_MS = 1000;
// The pauses between a failing account's checks: the check interval, doubled, then held at 30 minutes.
const RETRY_PAUSES_SECONDS = [600, 1200, 1800];
const PASSWORD = "s3cret-pw";
const FIRST_ADDRESS = "first@example.test";
const SECOND_ADDRESS = "second@example.test";
const SENDER = "ann@example.test";
// Every command of a slow server waits this long, so a check takes several of them.
const SLOW_ANSWER_MS = 1500;
const COMMAND_OUTPUT = "top-secret-output";

type AccountStatus = { name: string; status: string; lastError?: { message: string; at: string }; lastCheck?: string };
type Job = { request: { text: string } };

const rigs: MailRig[] = [];
const servers: FakeMailServer[] = [];
const envs: HermeticEnv[] = [];
const stops: (() => Promise<unknown>)[] = [];
const watches: FeedWatch[] = [];

afterEach(async () => {
    for (const watch of watches.splice(0)) watch.close();
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const rig of rigs.splice(0)) await rig.stop();
    for (const server of servers.splice(0)) await server.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

async function until<T>(
    description: string,
    attempt: () => Promise<T | undefined> | T | undefined,
    boundMs = WAIT_BOUND_MS,
): Promise<T> {
    const deadline = Date.now() + boundMs;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

type Invoker = { invoke(op: string, input: unknown): Promise<unknown> };

async function statuses(daemon: Invoker): Promise<AccountStatus[]> {
    return ((await daemon.invoke("daemon.status", {})) as { mailAccounts: AccountStatus[] }).mailAccounts;
}

async function statusOf(daemon: Invoker, name: string): Promise<AccountStatus> {
    const found = (await statuses(daemon)).find((account) => account.name === name);
    return found ?? assert.fail(`no account ${name} in daemon.status`);
}

const waitForStatus = (daemon: Invoker, name: string, status: string, boundMs = WAIT_BOUND_MS) =>
    until(
        `account ${name} to be ${status}`,
        async () => {
            const found = await statusOf(daemon, name);
            return found.status === status ? found : undefined;
        },
        boundMs,
    );

function ownedInput(server: FakeMailServer, name: string, address: string, extra: Record<string, unknown> = {}) {
    return {
        name,
        kind: "owned",
        address,
        imap_host: "127.0.0.1",
        imap_port: server.imapPort,
        imap_security: "none",
        smtp_host: "127.0.0.1",
        smtp_port: server.smtpPort,
        smtp_security: "none",
        auth: "password",
        password: PASSWORD,
        check_interval_seconds: CHECK_INTERVAL_SECONDS,
        ...extra,
    };
}

async function startRig(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [], clockStart: new Date(CLOCK_START) });
    rigs.push(rig);
    return rig;
}

const rawMail = (to: string, subject: string): string =>
    `From: ${SENDER}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n\r\nbody\r\n`;

async function waitForJobAbout(daemon: Invoker, subject: string): Promise<void> {
    await until(`a job about ${subject}`, async () => {
        const { jobs } = (await daemon.invoke("jobs.list", {})) as { jobs: Job[] };
        return jobs.find((job) => job.request.text.includes(subject)) ? true : undefined;
    });
}

const intakeWatching = (daemon: { stderr(): string }, name: string) =>
    until(`intake of ${name} to watch the inbox`, () =>
        new RegExp(`mail intake watching.*account=${name}`).test(daemon.stderr()) ? true : undefined,
    );

describe("an account whose server stops answering for an hour of test time (S-009 AC-005.1)", () => {
    it("shows it failing with the error, retries at growing pauses of at most 30 minutes, takes in mail for the other account and returns it to ready", {
        timeout: OUTAGE_TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startRig();
        const daemon = rig.process();
        const secondServer = await startFakeMailServer();
        servers.push(secondServer);
        rig.server.addAccount({ address: FIRST_ADDRESS, login: FIRST_ADDRESS, password: PASSWORD });
        secondServer.addAccount({ address: SECOND_ADDRESS, login: SECOND_ADDRESS, password: PASSWORD });
        await daemon.invoke("mail.accounts.create", ownedInput(rig.server, "first", FIRST_ADDRESS));
        await daemon.invoke("mail.accounts.create", ownedInput(secondServer, "second", SECOND_ADDRESS));
        await rig.waitForStatus("first", "ready");
        await rig.waitForStatus("second", "ready");
        await intakeWatching(daemon, "first");
        await intakeWatching(daemon, "second");

        let clock = CLOCK_START;
        const moveClockTo = async (time: number): Promise<void> => {
            clock = time;
            await rig.setClock(new Date(clock));
        };
        rig.server.pause();
        await moveClockTo(CLOCK_START + CHECK_INTERVAL_SECONDS * SECOND_MS);
        const failed = await waitForStatus(daemon, "first", "failing", FAILURE_BOUND_MS);
        assert.ok(failed.lastError && failed.lastError.message !== "", "the failing account carries its error");
        assert.equal((await statusOf(daemon, "second")).status, "ready");

        let lastCheck = failed.lastCheck as string;
        let mailCount = 0;
        let connectionsBefore = rig.server.openConnections();
        /** Moves the clock to just before the retry is due, and shows with the other account's mail that none started. */
        const assertNoRetryBefore = async (dueAt: number): Promise<void> => {
            await moveClockTo(dueAt - SECOND_MS);
            const subject = `during the outage ${++mailCount}`;
            secondServer.deliver(SECOND_ADDRESS, rawMail(SECOND_ADDRESS, subject));
            await waitForJobAbout(daemon, subject);
            assert.equal(rig.server.openConnections(), connectionsBefore, "no retry connected before it was due");
            assert.equal((await statusOf(daemon, "first")).lastCheck, lastCheck);
        };

        for (const [index, pause] of RETRY_PAUSES_SECONDS.entries()) {
            const dueAt = Date.parse(lastCheck) + pause * SECOND_MS;
            await assertNoRetryBefore(dueAt);
            const isLast = index === RETRY_PAUSES_SECONDS.length - 1;
            if (isLast) rig.server.resume();
            await moveClockTo(dueAt);
            if (isLast) break;
            const next = await until(
                `the retry due after ${pause} seconds to fail`,
                async () => {
                    const found = await statusOf(daemon, "first");
                    return found.lastCheck !== lastCheck ? found : undefined;
                },
                FAILURE_BOUND_MS,
            );
            assert.equal(next.status, "failing");
            assert.equal(next.lastCheck, new Date(dueAt).toISOString(), "the retry ran at the time it was due");
            lastCheck = next.lastCheck as string;
            connectionsBefore = rig.server.openConnections();
        }

        const back = await waitForStatus(daemon, "first", "ready");
        assert.ok(clock - CLOCK_START >= 3600 * SECOND_MS, "the outage lasted an hour of test time");
        assert.equal(back.lastCheck, new Date(clock).toISOString());
        await intakeWatching(daemon, "first");
        rig.server.deliver(FIRST_ADDRESS, rawMail(FIRST_ADDRESS, "after the outage"));
        await waitForJobAbout(daemon, "after the outage");
    });
});

type Fixture = { server: FakeMailServer; env: HermeticEnv; daemon: ReturnType<typeof startDaemon> };

async function startFixture(options: { security?: "none" | "tls"; trustAuthority: boolean }): Promise<Fixture> {
    const server = await startFakeMailServer(options.security ? { security: options.security } : {});
    servers.push(server);
    server.addAccount({ address: FIRST_ADDRESS, login: FIRST_ADDRESS, password: PASSWORD });
    const env = await createHermeticEnv();
    envs.push(env);
    const fixture = { server, env, daemon: launch(env, options.trustAuthority) };
    await fixture.daemon.ready;
    return fixture;
}

function launch(env: HermeticEnv, trustAuthority: boolean): ReturnType<typeof startDaemon> {
    const hermetic = trustAuthority ? { ...env, env: { ...env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } } : env;
    const daemon = startDaemon({
        hermetic,
        mailClock: new Date(CLOCK_START).toISOString(),
        networkListener: true,
    });
    stops.push(async () => {
        daemon.signal("SIGTERM");
        await daemon.exited;
    });
    return daemon;
}

async function watchStatusFeed(daemon: ReturnType<typeof startDaemon>): Promise<FeedWatch> {
    const watch = await watchFeed(await daemon.networkPort());
    watches.push(watch);
    return watch;
}

const isStatusDelta = (name: string, status: string) => (delta: FeedDelta) => {
    const change = delta as FeedDelta & { name?: string; status?: string };
    return change.type === "mail_account_status" && change.name === name && change.status === status;
};

describe("an account checked against a slow server (S-009 AC-005.2)", () => {
    it("shows connecting until its first connection ends and then ready, both on the feed, for a new account", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const { server, daemon } = await startFixture({ trustAuthority: false });
        server.setSlow(SLOW_ANSWER_MS);
        const feed = await watchStatusFeed(daemon);
        const connecting = feed.nextDelta(isStatusDelta("slow", "connecting"));
        const ready = feed.nextDelta(isStatusDelta("slow", "ready"));

        await daemon.invoke("mail.accounts.create", ownedInput(server, "slow", FIRST_ADDRESS));

        assert.equal((await statusOf(daemon, "slow")).status, "connecting");
        const first = await connecting;
        const second = await ready;
        assert.ok(first.delta.seq < second.delta.seq, "connecting reached the feed before ready");
        assert.equal((await statusOf(daemon, "slow")).status, "ready");
    });

    it("shows connecting after a restart until the first connection ends and then ready, which reaches the feed", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const { server, env, daemon } = await startFixture({ trustAuthority: false });
        await daemon.invoke("mail.accounts.create", ownedInput(server, "slow", FIRST_ADDRESS));
        await waitForStatus(daemon, "slow", "ready");
        daemon.signal("SIGTERM");
        await daemon.exited;
        server.setSlow(SLOW_ANSWER_MS);

        const restarted = launch(env, false);
        await restarted.ready;
        const feed = await watchStatusFeed(restarted);
        const ready = feed.nextDelta(isStatusDelta("slow", "ready"));

        assert.equal((await statusOf(restarted, "slow")).status, "connecting");
        await ready;
        assert.equal((await statusOf(restarted, "slow")).status, "ready");
    });
});

// A client can open the feed only once the daemon is ready, and the mail component publishes `connecting` while it
// starts, so the delta has no reader. Every status delta of the account that the feed carries, up to `ready`, is kept.
it("sends connecting and then ready to the feed after a restart", {
    timeout: TEST_TIMEOUT_MS,
    todo: "B-050",
}, async () => {
    const { server, env, daemon } = await startFixture({ trustAuthority: false });
    await daemon.invoke("mail.accounts.create", ownedInput(server, "slow", FIRST_ADDRESS));
    await waitForStatus(daemon, "slow", "ready");
    daemon.signal("SIGTERM");
    await daemon.exited;
    server.setSlow(SLOW_ANSWER_MS);

    const restarted = launch(env, false);
    await restarted.ready;
    const feed = await watchStatusFeed(restarted);
    const seen: string[] = [];
    await feed.nextDelta((delta) => {
        const change = delta as FeedDelta & { name?: string; status?: string };
        if (change.type !== "mail_account_status" || change.name !== "slow") return false;
        seen.push(change.status ?? "");
        return change.status === "ready";
    });

    assert.deepEqual(seen, ["connecting", "ready"]);
});

describe("a login that fails", () => {
    it("turns an account failing with the reason when the server's certificate doesn't verify (S-009 REQ-001)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const { server, daemon } = await startFixture({ security: "tls", trustAuthority: false });
        const tls = { imap_security: "tls", smtp_security: "tls" };

        await daemon.invoke("mail.accounts.create", ownedInput(server, "work", FIRST_ADDRESS, tls));

        const failed = await waitForStatus(daemon, "work", "failing");
        assert.match(failed.lastError?.message ?? "", /certificate/i);
    });

    it("turns the same account ready when the daemon trusts the server's authority", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const { server, daemon } = await startFixture({ security: "tls", trustAuthority: true });
        const tls = { imap_security: "tls", smtp_security: "tls" };

        await daemon.invoke("mail.accounts.create", ownedInput(server, "work", FIRST_ADDRESS, tls));

        await waitForStatus(daemon, "work", "ready");
    });

    it("turns an account failing with the exit status and none of the output when the password command fails (S-009 REQ-004)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const { server, daemon } = await startFixture({ trustAuthority: false });
        const command = [process.execPath, "-e", `process.stdout.write("${COMMAND_OUTPUT}"); process.exit(3)`];

        await daemon.invoke(
            "mail.accounts.create",
            ownedInput(server, "work", FIRST_ADDRESS, {
                auth: "password_command",
                password: undefined,
                password_command: command,
            }),
        );

        const failed = await waitForStatus(daemon, "work", "failing");
        assert.match(failed.lastError?.message ?? "", /exited with status 3/);
        assert.ok(!JSON.stringify(failed).includes(COMMAND_OUTPUT), "the command's output is nowhere in the status");
    });
});
