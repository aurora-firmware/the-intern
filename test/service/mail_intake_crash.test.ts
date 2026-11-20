/**
 * Intake across a real `kill -9` (S-009 REQ-021, AC-021.1; ADR-001 decision 4): the child daemon kills itself at a
 * write point of the mail component (`mailCrashAt`), the next child starts on the same instance while the fake server
 * is paused, and each email still ends as exactly one triage job, or as one input to the open job's lead.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { MailWritePoint } from "../../src/mail/mail_component.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(180_000);
const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const SERVER_DOWN_MS = scaled(300);
const EMAIL_COUNT = 20;
const KILL_COUNT = 3;
const CLOCK_START = "2026-03-02T09:00:00.000Z";
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";

type Job = { id: string; leadConversation?: string; status: string; request: { text: string } };
type Entry = { kind: string; data: { content?: string } };

const rigs: MailRig[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function until<T>(what: string, attempt: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

const rawMail = (subject: string, headers: string[] = []): string =>
    `From: ${SENDER}\r\nTo: ${ADDRESS}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n` +
    `${headers.map((header) => `${header}\r\n`).join("")}\r\nbody of ${subject}\r\n`;

const subjectOf = (job: Job): string | undefined => /Subject: (.*)/.exec(job.request.text)?.[1];

/** A rig whose own daemon is replaced by the tests' children, which take the crash switch the rig cannot pass. */
async function startRig(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
    rigs.push(rig);
    await rig.waitForStatus("work", "ready");
    rig.process().kill9();
    await rig.process().exited;
    return rig;
}

/** Starts a child on the rig's instance that dies at `mailCrashAt`, and waits until it is ready. */
async function launch(rig: MailRig, mailCrashAt?: MailWritePoint): Promise<DaemonProcess> {
    const daemon = startDaemon({
        hermetic: { ...rig.env, env: { ...rig.env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
        mailClock: CLOCK_START,
        oauthEndpoints: rig.oauth.endpoints,
        ...(mailCrashAt !== undefined && { mailCrashAt }),
    });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

const untilWatching = (daemon: DaemonProcess) =>
    until("intake to watch the inbox", async () =>
        daemon.stderr().includes("mail intake watching") ? true : undefined,
    );

async function untilKilled(daemon: DaemonProcess): Promise<void> {
    const outcome = await Promise.race([daemon.exited, sleep(WAIT_MS).then(() => "timeout" as const)]);
    assert.notEqual(outcome, "timeout", "the daemon was never killed");
    assert.equal((outcome as { signal: string | null }).signal, "SIGKILL");
}

const jobsOf = async (daemon: DaemonProcess) => ((await daemon.invoke("jobs.list", {})) as { jobs: Job[] }).jobs;

/** Kills a child at `point` as it takes in mail, `KILL_COUNT` times, with the server down while each next one starts. */
async function killRepeatedly(rig: MailRig, point: MailWritePoint, first: DaemonProcess): Promise<void> {
    let daemon = first;
    for (let kill = 1; kill <= KILL_COUNT; kill++) {
        await untilKilled(daemon);
        if (kill === KILL_COUNT) return;
        rig.server.pause();
        daemon = await launch(rig, point);
        await sleep(SERVER_DOWN_MS);
        rig.server.resume();
    }
}

describe("intake across a kill", () => {
    for (const point of ["mail-saved", "mail-routed"] as const) {
        it(`ends with one triage job for each of ${EMAIL_COUNT} emails after kills at ${point} (AC-1)`, {
            timeout: TEST_TIMEOUT_MS,
        }, async () => {
            const rig = await startRig();
            const first = await launch(rig, point);
            await untilWatching(first);
            const subjects = Array.from({ length: EMAIL_COUNT }, (_, n) => `email ${n}`);
            for (const subject of subjects) rig.deliver(ADDRESS, rawMail(subject));
            await killRepeatedly(rig, point, first);

            const last = await launch(rig);
            await untilWatching(last);
            const jobs = await until("every email to have a job", async () => {
                const found = await jobsOf(last);
                return found.length >= EMAIL_COUNT ? found : undefined;
            });
            rig.deliver(ADDRESS, rawMail("marker"));
            await until("the marker's job", async () =>
                (await jobsOf(last)).some((job) => subjectOf(job) === "marker") ? true : undefined,
            );
            const taken = (await jobsOf(last)).map(subjectOf).filter((subject) => subject !== "marker");
            assert.equal(jobs.length >= EMAIL_COUNT, true);
            assert.deepEqual(taken.toSorted(), subjects.toSorted());
        });
    }

    it("gives the lead of an open job a reply once after a kill at mail-routed (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startRig();
        const opener = await launch(rig);
        await untilWatching(opener);
        rig.deliver(ADDRESS, rawMail("question"));
        const job = await until("the question's job to block", async () => {
            const [listed] = await jobsOf(opener);
            if (listed === undefined) return undefined;
            const found = (await opener.invoke("jobs.get", { job: listed.id })) as Job;
            return found.status === "blocked" ? found : undefined;
        });
        opener.kill9();
        await opener.exited;

        const crashing = await launch(rig, "mail-routed");
        await untilWatching(crashing);
        rig.deliver(ADDRESS, rawMail("Re: question", ["In-Reply-To: <question@example.test>"]));
        await untilKilled(crashing);

        const restarted = await launch(rig);
        const steers = async () =>
            (
                (await restarted.invoke("conversations.entries", {
                    conversationId: job.leadConversation,
                    limit: 500,
                })) as { entries: Entry[] }
            ).entries.filter((entry) => entry.kind === "intern.steer" && entry.data.content?.includes("body of Re"));
        await until("the reply to reach the lead", async () => ((await steers()).length > 0 ? true : undefined));
        await sleep(SERVER_DOWN_MS);
        assert.equal((await steers()).length, 1);
        assert.equal((await jobsOf(restarted)).length, 1);
    });
});
