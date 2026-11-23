/**
 * Removing a mail account settles its owed mail and refuses its tools (T-437, S-009 REQ-003): each owed row turns
 * `account_removed` with its history entry, the account's jobs stay, and a tool that names it is refused.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ServiceContext } from "../../src/daemon/daemon.ts";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import { createJobStore, type JobStore, migrateJobStore } from "../../src/jobs/job_store.ts";
import type { MailAccount } from "../../src/mail/mail_model.ts";
import { mailAccountSection } from "../../src/mail/mail_section.ts";
import { createToolConnections, MailToolRefusal } from "../../src/mail/tool_connection.ts";
import { type MailOperationsDeps, mailOperations } from "../../src/service/mail_operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type Db = Awaited<ReturnType<typeof openHostDatabase>>;

const envs: HermeticEnv[] = [];
const databases: Db[] = [];

afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
    for (const env of envs.splice(0)) await env.dispose();
});

const account = (name: string): MailAccount =>
    ({
        name,
        kind: "owned",
        address: `${name}@example.test`,
        login: `${name}@example.test`,
        auth: "password_command",
        passwordCommand: ["true"],
        imapHost: "127.0.0.1",
        imapPort: 143,
        imapSecurity: "none",
        checkIntervalSeconds: 60,
    }) as unknown as MailAccount;

const owedRow = (job: string, key: string, name = "work") => ({
    key,
    job,
    account: name,
    kind: "question",
    recipients: ["ann@example.org"],
    subject: "Question",
    mailText: "What now?",
    inReplyTo: null,
    references: null,
});

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const db = await openHostDatabase(join(env.dataDir, "bob.sqlite"));
    databases.push(db);
    await migrateJobStore(db);
    const store: JobStore = createJobStore(db);
    let accounts = [account("work"), account("other")];
    const stopped: string[] = [];
    const ctx = {
        jobStore: store,
        config: {
            current: (section: unknown) => (section === mailAccountSection ? accounts : undefined),
            update: async (_section: unknown, change: (current: MailAccount[]) => MailAccount[]) => {
                accounts = change(accounts);
            },
        },
    } as unknown as ServiceContext;
    const deps: MailOperationsDeps = {
        agents: {} as never,
        accounts: { removeAccount: async () => {} } as never,
        secrets: {} as never,
        accountStatus: {} as never,
        control: { restartAccount: async () => {}, stopAccount: (name) => void stopped.push(name) },
    };
    const remove = async (name: string) => {
        const operation = mailOperations(deps).find((candidate) => candidate.name === "mail.accounts.remove");
        await operation?.run(ctx, { name } as never, {} as never);
    };
    return { store, remove, stopped, accountNamed: (name: string) => accounts.find((entry) => entry.name === name) };
}

describe("removing a mail account with owed mail", () => {
    it("turns each owed row account_removed with a history entry and leaves other accounts' rows (AC-1, AC-4)", async () => {
        const { store, remove } = await start();
        const { job } = await store.insertJob({
            letter: "E",
            requestText: "a request",
            origin: { kind: "request", wayIn: "email" },
            leadStart: { role: "lead" },
        });
        await store.writeMail(async (tx) => {
            await tx.insertOutbox(owedRow(job.id, "question:1"));
            await tx.insertOutbox(owedRow(job.id, "question:2"));
            await tx.insertOutbox(owedRow(job.id, "question:3", "other"));
        });

        await remove("work");

        const states = await store.readMail(async (tx) => [
            (await tx.outboxByKey("question:1"))?.state,
            (await tx.outboxByKey("question:2"))?.state,
            (await tx.outboxByKey("question:3"))?.state,
        ]);
        assert.deepEqual(states, ["account_removed", "account_removed", "owed"]);
        const owed = await store.readMail((tx) => tx.rowsInState("owed", "work"));
        assert.deepEqual(owed, []);
        const { entries } = await store.listHistory(job.number, {});
        const mail = entries.filter((entry) => entry.field === "mail");
        assert.equal(mail.length, 2);
        for (const entry of mail) {
            assert.equal((entry.new as { mail: string; from: string }).mail, "account_removed");
            assert.equal((entry.new as { from: string }).from, "work@example.test");
        }
    });

    it("keeps the account's jobs and stops its intake, sender and tools' connection (AC-2)", async () => {
        const { store, remove, stopped } = await start();
        const { job } = await store.insertJob({
            letter: "E",
            requestText: "a request",
            origin: { kind: "request", wayIn: "email" },
            leadStart: { role: "lead" },
        });

        await remove("work");

        assert.deepEqual(stopped, ["work"]);
        assert.equal((await store.listJobs({})).jobs.length, 1);
        assert.equal((await store.getJob(job.id))?.status, job.status);
    });

    it("refuses a mail tool that names the removed account with a reason (AC-3)", async () => {
        const { remove, accountNamed } = await start();
        const connections = createToolConnections({
            account: accountNamed,
            status: () => "ready",
            credential: async () => assert.fail("a removed account's tool must not open a connection"),
        });

        await remove("work");

        await assert.rejects(
            connections.use("work", async () => undefined),
            (error: Error) => error instanceof MailToolRefusal && /no mail account named "work"/.test(error.message),
        );
    });
});
