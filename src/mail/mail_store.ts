// The mail store (S-009 REQ-009, REQ-021, REQ-022; ADR-001 decision 4): reads and writes the `intern_mail_` tables in
// the transaction the job store hands it. It imports no pi package, no mail library and no other mail module, and from
// the job store only types.

import { randomUUID } from "node:crypto";
import type { HostSqlExecutor } from "../host/harness_host.ts";
import type { JobAuthor } from "../jobs/job_model.ts";
import type { MailHistoryEntry } from "../jobs/job_store.ts";

export type MailRoute = "new" | "related" | "input";
export type ThreadDirection = "in" | "out";
export type OutboxState =
    | "owed"
    | "sending"
    | "sent"
    | "held_back"
    | "refused"
    | "account_removed"
    | "may_not_have_gone_out";

export type NewMessage = {
    account: string;
    uidvalidity: number;
    uid: number;
    messageId: string | null;
    inReplyTo: string | null;
    references: string | null;
    sender: string | null;
    subject: string | null;
    date: string | null;
    raw: Uint8Array;
    size: number;
    attachments: unknown[];
    route: MailRoute | null;
    job: string | null;
};

export type MailMessageRow = Omit<NewMessage, "raw"> & { id: string; raw: Uint8Array | null; outcome: string | null };

export type IntakeRecord = { uidvalidity: number; nextUid: number; identity: string };

export type NewOutboxRow = {
    key: string;
    job: string;
    account: string | null;
    kind: string;
    recipients: string[];
    subject: string | null;
    mailText: string | null;
    inReplyTo: string | null;
    references: string | null;
};

export type OutboxRow = NewOutboxRow & {
    id: string;
    messageId: string | null;
    raw: Uint8Array | null;
    state: OutboxState;
    serverAnswer: string | null;
    copied: boolean | null;
};

export type OutboxChange = {
    messageId?: string;
    raw?: Uint8Array;
    serverAnswer?: string;
    copied?: boolean;
};

export type HistoryWriter = (jobId: string, entry: MailHistoryEntry, author: JobAuthor) => Promise<void>;

type MessageColumns = {
    id: string;
    account: string;
    uidvalidity: number;
    uid: number;
    message_id: string | null;
    in_reply_to: string | null;
    refs: string | null;
    sender: string | null;
    subject: string | null;
    date: string | null;
    raw: Uint8Array | null;
    size: number | null;
    attachments: string | null;
    route: MailRoute | null;
    job: string | null;
    outcome: string | null;
};

type OutboxColumns = {
    id: string;
    key: string;
    job: string;
    account: string | null;
    kind: string;
    recipients: string;
    subject: string | null;
    mail_text: string | null;
    in_reply_to: string | null;
    refs: string | null;
    message_id: string | null;
    raw: Uint8Array | null;
    state: OutboxState;
    server_answer: string | null;
    copied: number | null;
};

const toMessage = (row: MessageColumns): MailMessageRow => ({
    id: row.id,
    account: row.account,
    uidvalidity: row.uidvalidity,
    uid: row.uid,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    sender: row.sender,
    subject: row.subject,
    date: row.date,
    raw: row.raw,
    size: row.size ?? 0,
    attachments: JSON.parse(row.attachments ?? "[]"),
    route: row.route,
    job: row.job,
    outcome: row.outcome,
});

const toOutbox = (row: OutboxColumns): OutboxRow => ({
    id: row.id,
    key: row.key,
    job: row.job,
    account: row.account,
    kind: row.kind,
    recipients: JSON.parse(row.recipients),
    subject: row.subject,
    mailText: row.mail_text,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    messageId: row.message_id,
    raw: row.raw,
    state: row.state,
    serverAnswer: row.server_answer,
    copied: row.copied === null ? null : row.copied === 1,
});

/** Keeps an existing row for the same (account, UIDVALIDITY, UID) with its route, and returns the row. */
async function saveMessage(tx: HostSqlExecutor, message: NewMessage): Promise<MailMessageRow> {
    await tx.run(
        `INSERT OR IGNORE INTO intern_mail_messages
            (id, account, uidvalidity, uid, message_id, in_reply_to, refs, sender, subject, date, raw, size,
             attachments, route, job)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        message.account,
        message.uidvalidity,
        message.uid,
        message.messageId,
        message.inReplyTo,
        message.references,
        message.sender,
        message.subject,
        message.date,
        message.raw,
        message.size,
        JSON.stringify(message.attachments),
        message.route,
        message.job,
    );
    const row = await tx.get<MessageColumns>(
        "SELECT * FROM intern_mail_messages WHERE account = ? AND uidvalidity = ? AND uid = ?",
        message.account,
        message.uidvalidity,
        message.uid,
    );
    if (!row) throw new Error(`Saved email ${message.account}/${message.uidvalidity}/${message.uid} is not readable`);
    return toMessage(row);
}

async function recordIntakeOutcome(
    tx: HostSqlExecutor,
    id: string,
    result: { outcome: string; route?: MailRoute; job?: string },
): Promise<void> {
    await tx.run(
        "UPDATE intern_mail_messages SET outcome = ?, route = COALESCE(?, route), job = COALESCE(?, job) WHERE id = ?",
        result.outcome,
        result.route ?? null,
        result.job ?? null,
        id,
    );
}

async function readIntake(tx: HostSqlExecutor, account: string): Promise<IntakeRecord | undefined> {
    const row = await tx.get<{ uidvalidity: number; next_uid: number; identity: string }>(
        "SELECT uidvalidity, next_uid, identity FROM intern_mail_intake WHERE account = ?",
        account,
    );
    return row && { uidvalidity: row.uidvalidity, nextUid: row.next_uid, identity: row.identity };
}

async function writeIntake(tx: HostSqlExecutor, account: string, record: IntakeRecord): Promise<void> {
    await tx.run(
        `INSERT INTO intern_mail_intake (account, uidvalidity, next_uid, identity) VALUES (?, ?, ?, ?)
         ON CONFLICT (account) DO UPDATE SET
            uidvalidity = excluded.uidvalidity, next_uid = excluded.next_uid, identity = excluded.identity`,
        account,
        record.uidvalidity,
        record.nextUid,
        record.identity,
    );
}

/** Removes the intake record of every account not named. Saved messages stay: the jobs hold them. */
async function removeIntakeExcept(tx: HostSqlExecutor, accounts: readonly string[]): Promise<void> {
    const marks = accounts.map(() => "?").join(", ");
    await tx.run(`DELETE FROM intern_mail_intake WHERE account NOT IN (${marks})`, ...accounts);
}

async function addThread(
    tx: HostSqlExecutor,
    row: { messageId: string; job: string; direction: ThreadDirection },
): Promise<void> {
    await tx.run(
        "INSERT INTO intern_mail_thread (message_id, job, direction) VALUES (?, ?, ?)",
        row.messageId,
        row.job,
        row.direction,
    );
}

/** The job of each recorded `Message-ID` among those given. An unrecorded one is absent from the map. */
async function jobsOfMessageIds(tx: HostSqlExecutor, messageIds: readonly string[]): Promise<Map<string, string>> {
    const jobs = new Map<string, string>();
    for (const messageId of messageIds) {
        const row = await tx.get<{ job: string }>(
            "SELECT job FROM intern_mail_thread WHERE message_id = ? ORDER BY rowid LIMIT 1",
            messageId,
        );
        if (row) jobs.set(messageId, row.job);
    }
    return jobs;
}

async function insertOutbox(tx: HostSqlExecutor, row: NewOutboxRow): Promise<OutboxRow> {
    const id = randomUUID();
    await tx.run(
        `INSERT INTO intern_mail_outbox (id, key, job, account, kind, recipients, subject, mail_text, in_reply_to, refs, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owed')`,
        id,
        row.key,
        row.job,
        row.account,
        row.kind,
        JSON.stringify(row.recipients),
        row.subject,
        row.mailText,
        row.inReplyTo,
        row.references,
    );
    const stored = await outboxByKey(tx, row.key);
    if (!stored) throw new Error(`Outbox row ${row.key} is not readable`);
    return stored;
}

async function outboxByKey(tx: HostSqlExecutor, key: string): Promise<OutboxRow | undefined> {
    const row = await tx.get<OutboxColumns>("SELECT * FROM intern_mail_outbox WHERE key = ?", key);
    return row && toOutbox(row);
}

/** The account's `owed` rows, oldest first. */
function owedRows(tx: HostSqlExecutor, account: string): Promise<OutboxRow[]> {
    return rowsInState(tx, "owed", account);
}

async function setOutboxState(
    tx: HostSqlExecutor,
    id: string,
    state: OutboxState,
    change: OutboxChange = {},
): Promise<void> {
    await tx.run(
        `UPDATE intern_mail_outbox SET state = ?, message_id = COALESCE(?, message_id), raw = COALESCE(?, raw),
            server_answer = COALESCE(?, server_answer), copied = COALESCE(?, copied) WHERE id = ?`,
        state,
        change.messageId ?? null,
        change.raw ?? null,
        change.serverAnswer ?? null,
        change.copied === undefined ? null : Number(change.copied),
        id,
    );
}

/** The rows in one state, oldest first, for one account or for all. */
async function rowsInState(tx: HostSqlExecutor, state: OutboxState, account?: string): Promise<OutboxRow[]> {
    const rows =
        account === undefined
            ? await tx.all<OutboxColumns>("SELECT * FROM intern_mail_outbox WHERE state = ? ORDER BY rowid", state)
            : await tx.all<OutboxColumns>(
                  "SELECT * FROM intern_mail_outbox WHERE state = ? AND account = ? ORDER BY rowid",
                  state,
                  account,
              );
    return rows.map(toOutbox);
}

/** Turns the account's `owed` rows `account_removed`, each with its history entry by the daemon. */
async function markAccountRemoved(
    tx: HostSqlExecutor,
    addHistory: HistoryWriter,
    account: string,
    address: string,
): Promise<void> {
    for (const row of await rowsInState(tx, "owed", account)) {
        await setOutboxState(tx, row.id, "account_removed");
        await addHistory(
            row.job,
            { mail: "account_removed", from: address, to: row.recipients, subject: row.subject ?? "" },
            { kind: "daemon" },
        );
    }
}

/** The job's newest question row that wasn't held back, or undefined. */
async function newestQuestion(tx: HostSqlExecutor, job: string): Promise<OutboxRow | undefined> {
    const row = await tx.get<OutboxColumns>(
        "SELECT * FROM intern_mail_outbox WHERE job = ? AND kind = 'question' AND state <> 'held_back' ORDER BY rowid DESC LIMIT 1",
        job,
    );
    return row && toOutbox(row);
}

/** The saved emails of one job, oldest first. */
async function emailRowsOf(tx: HostSqlExecutor, job: string): Promise<MailMessageRow[]> {
    const rows = await tx.all<MessageColumns>("SELECT * FROM intern_mail_messages WHERE job = ? ORDER BY rowid", job);
    return rows.map(toMessage);
}

/** The store's functions bound to one job store transaction. */
export function bindMailStore(tx: HostSqlExecutor, addHistory: HistoryWriter) {
    return {
        saveMessage: (message: NewMessage) => saveMessage(tx, message),
        recordIntakeOutcome: (id: string, result: { outcome: string; route?: MailRoute; job?: string }) =>
            recordIntakeOutcome(tx, id, result),
        readIntake: (account: string) => readIntake(tx, account),
        writeIntake: (account: string, record: IntakeRecord) => writeIntake(tx, account, record),
        removeIntakeExcept: (accounts: readonly string[]) => removeIntakeExcept(tx, accounts),
        addThread: (row: { messageId: string; job: string; direction: ThreadDirection }) => addThread(tx, row),
        jobsOfMessageIds: (messageIds: readonly string[]) => jobsOfMessageIds(tx, messageIds),
        insertOutbox: (row: NewOutboxRow) => insertOutbox(tx, row),
        outboxByKey: (key: string) => outboxByKey(tx, key),
        owedRows: (account: string) => owedRows(tx, account),
        setOutboxState: (id: string, state: OutboxState, change?: OutboxChange) =>
            setOutboxState(tx, id, state, change),
        rowsInState: (state: OutboxState, account?: string) => rowsInState(tx, state, account),
        markAccountRemoved: (account: string, address: string) => markAccountRemoved(tx, addHistory, account, address),
        newestQuestion: (job: string) => newestQuestion(tx, job),
        emailRowsOf: (job: string) => emailRowsOf(tx, job),
    };
}

export type MailStoreFunctions = ReturnType<typeof bindMailStore>;
