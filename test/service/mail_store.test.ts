import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import { createJobStore, migrateJobStore, type NewJob } from "../../src/jobs/job_store.ts";
import type { NewMessage } from "../../src/mail/mail_store.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type Db = Awaited<ReturnType<typeof openHostDatabase>>;

const envs: HermeticEnv[] = [];
const databases: Db[] = [];

afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
    for (const env of envs.splice(0)) await env.dispose();
});

async function openStore() {
    const env = await createHermeticEnv();
    envs.push(env);
    const db = await openHostDatabase(join(env.dataDir, "bob.sqlite"));
    databases.push(db);
    await migrateJobStore(db);
    return { db, store: createJobStore(db) };
}

const newJob = (extra: Partial<NewJob> = {}): NewJob => ({
    letter: "E",
    requestText: "a request",
    origin: { kind: "request", wayIn: "email" },
    leadStart: { role: "lead" },
    ...extra,
});

const message = (extra: Partial<NewMessage> = {}): NewMessage => ({
    account: "work",
    uidvalidity: 7,
    uid: 11,
    messageId: "<one@example.org>",
    inReplyTo: null,
    references: null,
    sender: "ann@example.org",
    subject: "Hello",
    date: "2026-11-19T10:00:00.000Z",
    raw: new Uint8Array([1, 2, 3]),
    size: 3,
    attachments: [],
    route: "new",
    job: null,
    ...extra,
});

const outboxRow = (job: string, key: string, account = "work") => ({
    key,
    job,
    account,
    kind: "question",
    recipients: ["ann@example.org"],
    subject: "Question",
    mailText: "What now?",
    inReplyTo: null,
    references: null,
});

const daemon = { kind: "daemon" } as const;

describe("mail store", () => {
    it("keeps the first row and its route when the same email is saved twice", async () => {
        const { db, store } = await openStore();
        const first = await store.writeMail((tx) => tx.saveMessage(message({ route: "new" })));
        const second = await store.writeMail((tx) => tx.saveMessage(message({ route: "related", subject: "Changed" })));
        assert.equal(second.id, first.id);
        assert.equal(second.route, "new");
        assert.equal(second.subject, "Hello");
        const count = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM intern_mail_messages");
        assert.equal(count?.n, 1);
    });

    it("appends a mail history entry with old null and the kind, sender, recipients and subject", async () => {
        const { store } = await openStore();
        const { job } = await store.insertJob(newJob());
        await store.writeMail(async (tx) => {
            await tx.addMailHistory(
                job.id,
                {
                    mail: "held_back",
                    from: "bob@example.org",
                    to: ["x@example.net"],
                    subject: "Hi",
                    notAllowed: ["x@example.net"],
                },
                daemon,
            );
            await tx.addMailHistory(
                job.id,
                {
                    mail: "refused",
                    from: "bob@example.org",
                    to: ["y@example.net"],
                    subject: "Hi",
                    serverAnswer: "550 no",
                },
                { kind: "agent", conversationId: "c1", role: "lead" },
            );
            await tx.addMailHistory(
                job.id,
                { mail: "account_removed", from: "bob@example.org", to: [], subject: "Hi" },
                daemon,
            );
            await tx.addMailHistory(
                job.id,
                { mail: "not_sent", from: "bob@example.org", to: [], subject: "Hi" },
                daemon,
            );
            await tx.addMailHistory(
                job.id,
                { mail: "sent", from: "bob@example.org", to: ["z@example.net"], subject: "Hi" },
                daemon,
            );
        });
        const { entries } = await store.listHistory(job.number, {});
        assert.deepEqual(
            entries.map((entry) => [entry.field, entry.old, entry.new]),
            [
                [
                    "mail",
                    null,
                    {
                        mail: "held_back",
                        from: "bob@example.org",
                        to: ["x@example.net"],
                        subject: "Hi",
                        notAllowed: ["x@example.net"],
                    },
                ],
                [
                    "mail",
                    null,
                    {
                        mail: "refused",
                        from: "bob@example.org",
                        to: ["y@example.net"],
                        subject: "Hi",
                        serverAnswer: "550 no",
                        text: "refused by the server",
                    },
                ],
                [
                    "mail",
                    null,
                    {
                        mail: "account_removed",
                        from: "bob@example.org",
                        to: [],
                        subject: "Hi",
                        text: "not sent: account removed",
                    },
                ],
                [
                    "mail",
                    null,
                    {
                        mail: "not_sent",
                        from: "bob@example.org",
                        to: [],
                        subject: "Hi",
                        text: "result reply not sent: no mail text",
                    },
                ],
                ["mail", null, { mail: "sent", from: "bob@example.org", to: ["z@example.net"], subject: "Hi" }],
            ],
        );
        assert.deepEqual(entries[1]?.author, { kind: "agent", conversationId: "c1", role: "lead" });
    });

    it("writes the history entry in the same transaction as the rows", async () => {
        const { db, store } = await openStore();
        const { job } = await store.insertJob(newJob());
        await store.writeMail(async (tx) => {
            await tx.insertOutbox(outboxRow(job.id, "question:1"));
            await tx.addMailHistory(job.id, { mail: "sent", from: "a@b.c", to: ["d@e.f"], subject: "S" }, daemon);
            const inside = await tx.outboxByKey("question:1");
            assert.equal(inside?.state, "owed");
        });
        const rows = await db.all("SELECT key FROM intern_mail_outbox");
        assert.equal(rows.length, 1);
        assert.equal((await store.listHistory(job.number, {})).entries.length, 1);
    });

    it("rolls back every row and history entry when the work throws", async () => {
        const { db, store } = await openStore();
        const { job } = await store.insertJob(newJob());
        await assert.rejects(
            store.writeMail(async (tx) => {
                await tx.saveMessage(message());
                await tx.insertOutbox(outboxRow(job.id, "question:1"));
                await tx.addThread({ messageId: "<one@example.org>", job: job.id, direction: "in" });
                await tx.addMailHistory(job.id, { mail: "sent", from: "a@b.c", to: ["d@e.f"], subject: "S" }, daemon);
                throw new Error("work failed");
            }),
            /work failed/,
        );
        for (const table of ["intern_mail_messages", "intern_mail_outbox", "intern_mail_thread"]) {
            const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
            assert.equal(count?.n, 0, table);
        }
        assert.equal((await store.listHistory(job.number, {})).entries.length, 0);
    });

    it("finds the job of any recorded Message-ID", async () => {
        const { store } = await openStore();
        const a = (await store.insertJob(newJob())).job;
        const b = (await store.insertJob(newJob())).job;
        await store.writeMail(async (tx) => {
            await tx.addThread({ messageId: "<a1@example.org>", job: a.id, direction: "in" });
            await tx.addThread({ messageId: "<a2@example.org>", job: a.id, direction: "out" });
            await tx.addThread({ messageId: "<b1@example.org>", job: b.id, direction: "in" });
        });
        const found = await store.readMail((tx) =>
            tx.jobsOfMessageIds(["<a2@example.org>", "<b1@example.org>", "<unknown@example.org>"]),
        );
        assert.deepEqual([...found.entries()].sort(), [
            ["<a2@example.org>", a.id],
            ["<b1@example.org>", b.id],
        ]);
    });

    it("turns the account's owed rows account_removed with an entry each and leaves other rows unchanged", async () => {
        const { store } = await openStore();
        const { job } = await store.insertJob(newJob());
        const ids = await store.writeMail(async (tx) => {
            const owed = await tx.insertOutbox(outboxRow(job.id, "question:1"));
            const owedToo = await tx.insertOutbox(outboxRow(job.id, "question:2"));
            const sending = await tx.insertOutbox(outboxRow(job.id, "question:3"));
            const sent = await tx.insertOutbox(outboxRow(job.id, "question:4"));
            const other = await tx.insertOutbox(outboxRow(job.id, "question:5", "other"));
            await tx.setOutboxState(sending.id, "sending");
            await tx.setOutboxState(sent.id, "sent");
            return { owed, owedToo, sending, sent, other };
        });
        await store.writeMail((tx) => tx.markAccountRemoved("work", "bob@example.org"));
        const states = await store.readMail(async (tx) => ({
            owed: (await tx.outboxByKey("question:1"))?.state,
            owedToo: (await tx.outboxByKey("question:2"))?.state,
            sending: (await tx.outboxByKey("question:3"))?.state,
            sent: (await tx.outboxByKey("question:4"))?.state,
            other: (await tx.outboxByKey("question:5"))?.state,
        }));
        assert.deepEqual(states, {
            owed: "account_removed",
            owedToo: "account_removed",
            sending: "sending",
            sent: "sent",
            other: "owed",
        });
        assert.ok(ids.owed.id);
        const { entries } = await store.listHistory(job.number, {});
        assert.equal(entries.length, 2);
        for (const entry of entries) {
            assert.deepEqual(entry.new, {
                mail: "account_removed",
                from: "bob@example.org",
                to: ["ann@example.org"],
                subject: "Question",
                text: "not sent: account removed",
            });
            assert.deepEqual(entry.author, daemon);
        }
    });
});
