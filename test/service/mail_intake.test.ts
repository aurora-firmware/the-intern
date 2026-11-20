/**
 * Intake (S-009 REQ-006, REQ-007, REQ-009: AC-006.1, AC-006.2, AC-007.1, AC-009.2 and the open-job route of AC-009.1):
 * each new email of an owned inbox becomes a triage job or input to the open job of its thread, on the mail rig.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FakeMailServer } from "../support/fake_mail_server.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";
const AFTER_RETRY_PAUSE = "2026-03-02T11:00:00.000Z";
const EXISTING_MESSAGES = 5000;

type Job = {
    id: string;
    number: string;
    status: string;
    related: string[];
    request: { text: string; origin: { kind: string; wayIn: string; observed?: Record<string, string> } };
};

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
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
        a.number.localeCompare(b.number, undefined, { numeric: true }),
    );

/**
 * Starts the rig with the account unknown to the server, so its first connection comes after the test has filled the
 * inbox, and waits until intake has recorded its starting point.
 */
async function startWatching(existing: (server: FakeMailServer) => void = () => undefined): Promise<MailRig> {
    const rig = await startMailRig({
        accounts: [{ name: "work", address: ADDRESS, password: PASSWORD, isKnownToServer: false }],
    });
    rigs.push(rig);
    await rig.waitForStatus("work", "failing");
    rig.server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    existing(rig.server);
    await rig.setClock(new Date(AFTER_RETRY_PAUSE));
    await rig.waitForStatus("work", "ready");
    await until("intake to watch the inbox", () =>
        rig.process().stderr().includes("mail intake watching") ? true : undefined,
    );
    return rig;
}

const rawMail = (subject: string, text: string, headers: string[] = []): string =>
    [
        `From: ${SENDER}`,
        `To: ${ADDRESS}`,
        `Subject: ${subject}`,
        `Message-ID: <${subject.replaceAll(" ", "-")}@example.test>`,
        ...headers,
        "",
        text,
        "",
    ].join("\r\n");

describe("intake", { timeout: TEST_TIMEOUT_MS }, () => {
    it("leaves the existing inbox alone and takes the one email that arrives (AC-1)", async () => {
        const rig = await startWatching((server) => {
            for (let n = 0; n < EXISTING_MESSAGES; n++) server.deliver(ADDRESS, rawMail(`old ${n}`, "old"));
        });

        rig.deliver(ADDRESS, rawMail("new one", "hello"));

        await rig.waitForJob(() => true);
        const jobs = await jobsOf(rig);
        assert.equal(jobs.length, 1);
        assert.match(jobs[0]?.request.text ?? "", /Subject: new one/);
    });
});
