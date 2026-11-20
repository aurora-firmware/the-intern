/**
 * Intake (S-009 REQ-006, REQ-007, REQ-009: AC-006.1, AC-006.2, AC-007.1, AC-009.2 and the open-job route of AC-009.1):
 * each new email of an owned inbox becomes a triage job or input to the open job of its thread, on the mail rig.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { composeMessage } from "../../src/mail/mime.ts";
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

type Entry = { field: string; old: unknown; new: unknown; author: { kind: string } };
type Job = {
    id: string;
    leadConversation?: string;
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

const jobOf = async (rig: MailRig, job: Job | undefined) =>
    (await rig.process().invoke("jobs.get", { job: job?.id })) as Job;

async function untilJobs(rig: MailRig, count: number): Promise<Job[]> {
    return until(`${count} jobs`, async () => {
        const jobs = await jobsOf(rig);
        return jobs.length >= count ? jobs : undefined;
    });
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

    it("makes one job for each of an ordinary email, an auto-reply, a failure report and a list message (AC-2)", async () => {
        const rig = await startWatching();
        const subjects = ["ordinary", "out of office", "delivery failure", "list message"];
        const headers: Record<string, string[]> = {
            "out of office": ["Auto-Submitted: auto-replied", "Precedence: auto_reply"],
            "delivery failure": ["Content-Type: multipart/report; report-type=delivery-status; boundary=b"],
            "list message": ["List-Id: <news.example.test>", "Precedence: bulk"],
        };

        for (const subject of subjects) rig.deliver(ADDRESS, rawMail(subject, "body", headers[subject]));

        const jobs = await untilJobs(rig, subjects.length);
        assert.equal(jobs.length, subjects.length);
        for (const subject of subjects) {
            assert.equal(jobs.filter((job) => job.request.text.includes(`Subject: ${subject}`)).length, 1, subject);
        }
        assert.deepEqual(rig.server.received(), []);
    });

    it("saves the message and its attachments and leaves the message in INBOX unflagged (AC-3)", async () => {
        const rig = await startWatching();
        const pdf = Buffer.from(Array.from({ length: 10_240 }, (_, index) => (index * 31 + 7) % 256));
        const note = Buffer.from("remember the milk");
        const sent = await composeMessage({
            from: SENDER,
            to: [ADDRESS],
            subject: "with files",
            text: "see attached",
            attachments: [
                { filename: "report.pdf", contentType: "application/pdf", content: pdf },
                { filename: "note.txt", contentType: "text/plain", content: note },
            ],
        });

        rig.deliver(ADDRESS, sent.raw);

        const [job] = await untilJobs(rig, 1);
        assert.deepEqual(job?.request.origin, {
            kind: "request",
            wayIn: "email",
            observed: { account: "work", messageId: sent.messageId, sender: SENDER },
        });
        const view = (await rig.process().invoke("jobs.get", { job: job?.id })) as { leadConversation: string };
        const lead = (await rig.process().invoke("conversations.get", { conversationId: view.leadConversation })) as {
            seat: { role: string };
        };
        assert.equal(lead.seat.role, "triage");
        const paths = [...(job?.request.text.matchAll(/^(?:Saved message: |- )(\/.+)$/gm) ?? [])].map(
            (match) => match[1],
        );
        assert.equal(paths.length, 3);
        const [message, ...attachments] = await Promise.all(paths.map((path) => readFile(path as string)));
        assert.deepEqual(message, sent.raw);
        assert.deepEqual(attachments, [pdf, note]);
        const [stored] = rig.server.mailbox(ADDRESS, "INBOX");
        assert.deepEqual([stored?.flags, stored?.raw], [[], sent.raw]);
    });

    it("makes a Done job's reply a related job, and an unthreaded quote of it a job related to nothing (AC-4)", async () => {
        const rig = await startWatching();
        rig.deliver(ADDRESS, rawMail("first", "please file this"));
        const [first] = await untilJobs(rig, 1);
        await until("the first job to settle", async () =>
            (await jobOf(rig, first)).status === "blocked" ? true : undefined,
        );
        const finished = await rig.process().invoke("jobs.cancel", { job: first?.id, justification: "not needed" });
        assert.equal((finished as Job).status, "done");

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

    it("delivers a reply in a Blocked job's thread to its lead as input and resumes the job (AC-5)", async () => {
        const rig = await startWatching();
        rig.deliver(ADDRESS, rawMail("question", "please file this"));
        const [job] = await untilJobs(rig, 1);
        await until("the job to block", async () => ((await jobOf(rig, job)).status === "blocked" ? true : undefined));
        const lead = (await jobOf(rig, job)).leadConversation as string;

        rig.deliver(ADDRESS, rawMail("Re: question", "use the staging one", ["In-Reply-To: <question@example.test>"]));

        const history = () =>
            rig.process().invoke("jobs.history.list", { job: job?.id, limit: 100 }) as Promise<{ entries: Entry[] }>;
        await until("the reply to be recorded", async () =>
            (await history()).entries.filter((entry) => entry.field === "mail").length === 2 ? true : undefined,
        );
        const { entries } = await history();
        assert.ok(
            entries.some((entry) => entry.field === "status" && entry.old === "blocked" && entry.new === "in_progress"),
            "the job resumed",
        );
        const { entries: leadEntries } = (await rig.process().invoke("conversations.entries", {
            conversationId: lead,
            limit: 500,
        })) as { entries: { kind: string; data: { actor: unknown; content: string } }[] };
        const [steer] = leadEntries.filter((entry) => entry.kind === "intern.steer");
        assert.deepEqual(steer?.data.actor, { kind: "team_member", wayIn: "email" });
        assert.match(steer?.data.content ?? "", /From: ann@example\.test[\s\S]*use the staging one/);
        assert.equal((await jobsOf(rig)).length, 1);
    });
});
