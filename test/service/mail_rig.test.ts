/**
 * The mail test rig (T-425): the mail component in the test daemon process, with the test clock and the fake provider's
 * endpoints, and a rig that starts and stops the daemon with the fake mail server and the fake OAuth provider.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_BOUND_MS = scaled(20_000);
const POLL_INTERVAL_MS = 10;
const ADDRESS = "bob@example.test";
const PASSWORD = "s3cret";
const START_TIME = "2026-03-02T09:00:00.000Z";
const AFTER_RETRY_PAUSE = "2026-03-02T11:00:00.000Z";

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function start(options: Parameters<typeof startMailRig>[0]): Promise<MailRig> {
    const rig = await startMailRig(options);
    rigs.push(rig);
    return rig;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function untilTrue(description: string, isWanted: () => boolean): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (!isWanted()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

describe("the mail test rig", () => {
    it("runs the mail component with the test clock in the daemon process (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });

        await rig.setClock(new Date(AFTER_RETRY_PAUSE));
    });

    it("points the mail component at the fake provider's endpoints (AC-1)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await start({
            accounts: [
                {
                    name: "work",
                    address: ADDRESS,
                    microsoftApp: { clientId: "client-1", tenant: "contoso" },
                    isKnownToServer: false,
                },
            ],
        });

        await untilTrue("the provider to receive a token request", () =>
            rig.oauth.requests().some((request) => request.path.endsWith("/oauth2/v2.0/token")),
        );
    });

    it("turns an owned account on the fake server ready in daemon.status (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });

        await rig.waitForStatus("work", "ready");
    });

    it("retries a failing account when the mail clock passes its pause (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({
            clockStart: new Date(START_TIME),
            accounts: [{ name: "work", address: ADDRESS, password: PASSWORD, isKnownToServer: false }],
        });
        await rig.waitForStatus("work", "failing");
        rig.server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });

        await rig.setClock(new Date(AFTER_RETRY_PAUSE));

        await rig.waitForStatus("work", "ready");
    });

    it("turns the account ready again after a restart on the same directories", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
        await rig.waitForStatus("work", "ready");

        await rig.restart();

        await rig.waitForStatus("work", "ready");
    });

    it("puts a delivered message in the address's inbox on the fake server", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
        const raw = `From: a@example.test\r\nTo: ${ADDRESS}\r\nSubject: hello\r\n\r\nbody\r\n`;

        rig.deliver(ADDRESS, raw);

        assert.deepEqual(
            rig.server.mailbox(ADDRESS, "INBOX").map((message) => message.raw.toString()),
            [raw],
        );
    });

    it("settles with the job a predicate accepts", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
        const created = (await rig.process().invoke("jobs.create", { text: "probe" })) as { id: string };

        const found = await rig.waitForJob((job) => job.id === created.id);

        assert.equal(found.id, created.id);
    });

    it("waits for a job that matches a predicate", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
        await rig.waitForStatus("work", "ready");

        await assert.rejects(
            rig.waitForJob(() => false, { timeoutMs: scaled(300) }),
            /timed out/,
        );
    });

    it("stops the daemon, the fake server and the provider, leaving no process behind (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
        await rig.waitForStatus("work", "ready");
        const { pid } = rig.process();

        await rig.stop();

        assert.equal(isAlive(pid), false);
        assert.equal(rig.server.openConnections(), 0);
        await assert.rejects(fetch(rig.oauth.endpoints.googleToken, { method: "POST" }));
    });
});
