/**
 * The outbox (S-009 REQ-012 to REQ-015, REQ-022; ADR-001 decision 4). The mail policy the mail component registers
 * with the jobs component decides the mail a block or a completion owes, and the email details `jobs.get` returns: it
 * reads through the job store's mail transaction and never writes; the job write inserts the owed row it returns. The
 * senders, one for each account, send the `owed` rows once, oldest first.
 */
import { basename } from "node:path";
import type { Credential } from "../accounts/providers.ts";
import type { Logger } from "../daemon/logger.ts";
import type { JobAuthor } from "../jobs/job_model.ts";
import type { Job, JobStore, MailTx } from "../jobs/job_store.ts";
import type { JobEmail, MailAsk, MailDecision, MailPolicy, OwedMail } from "../jobs/mail_policy.ts";
import { openImap } from "./imap_client.ts";
import {
    heldBackNotice,
    isAllowed,
    type MailAccount,
    type MailNotice,
    type MailNoticeText,
    notAllowedRecipients,
    questionSubject,
    refusedNotice,
} from "./mail_model.ts";
import type { MailMessageRow, NewOutboxRow, OutboxRow, OutboxState } from "./mail_store.ts";
import { type ComposeAttachment, composeMessage, parseMessage } from "./mime.ts";
import { savedCopyPaths } from "./saved_copy.ts";
import { type SmtpOutcome, sendRaw } from "./smtp_client.ts";

export type MailPolicyDeps = {
    jobStore: JobStore;
    /** The configured accounts, read at each ask so a change to the file is seen. */
    accounts: () => readonly MailAccount[];
    notice: () => MailNotice | undefined;
    mailDir: string;
    /** Called after the commit of a job write that owes mail, so the senders take the row. */
    committed?: () => void;
};

type Destination = { account: string; recipient: string; replyTo: "job" | "notice" };

// The states of rows that stand for an email of the job: not one the allowlist held back, the server refused or a
// removed account left unsent.
const THREAD_STATES: readonly OutboxState[] = ["owed", "sending", "sent", "may_not_have_gone_out"];
const ALL_STATES: readonly OutboxState[] = [...THREAD_STATES, "held_back", "refused", "account_removed"];

const isBlank = (text: string | undefined): text is undefined => text === undefined || text.trim() === "";

const canSend = (account: MailAccount | undefined): account is MailAccount =>
    account?.kind === "owned" && account.smtpHost !== undefined;

// The number in a key `question:<jobId>:<n>`.
const questionNumber = (row: OutboxRow): number => Number(row.key.slice(row.key.lastIndexOf(":") + 1));

async function blockCount(jobStore: JobStore, job: Job): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    do {
        const page = await jobStore.listHistory(job.id, cursor === undefined ? {} : { cursor });
        count += page.entries.filter((entry) => entry.field === "status" && entry.new === "blocked").length;
        cursor = page.cursor;
    } while (cursor !== undefined);
    return count;
}

const outboxRowsOf = (jobStore: JobStore, jobId: string, states: readonly OutboxState[]): Promise<OutboxRow[]> =>
    jobStore.readMail((tx) => tx.outboxRowsOfJob(jobId, states));

const headersOf = (received: MailMessageRow[]): { inReplyTo: string | null; references: string | null } => {
    const ids = received.flatMap((row) => (row.messageId === null ? [] : [row.messageId]));
    return { inReplyTo: ids.at(-1) ?? null, references: ids.length === 0 ? null : ids.join(" ") };
};

// Oldest first; an email with no date yet, a composed-later sent row, goes last.
const byDate = (a: { date: string | null }, b: { date: string | null }): number => {
    const [left, right] = [a, b].map(({ date }) => (date === null ? Number.POSITIVE_INFINITY : Date.parse(date)));
    return left === right ? 0 : (left as number) < (right as number) ? -1 : 1;
};

export function createMailPolicy(deps: MailPolicyDeps): MailPolicy {
    const { jobStore } = deps;
    const accountNamed = (name: string | undefined) => deps.accounts().find((account) => account.name === name);
    const emailsOf = (jobId: string) => jobStore.readMail((tx) => tx.emailRowsOf(jobId));

    // The job's account that can send, when the job came by email, and the sender of its first email.
    async function emailSender(job: Job): Promise<{ account: MailAccount; sender: string } | undefined> {
        const account = accountNamed(job.mailAccount);
        if (!canSend(account)) return undefined;
        const sender = (await emailsOf(job.id))[0]?.sender;
        return sender === null || sender === undefined ? undefined : { account, sender };
    }

    async function blockDestination(job: Job): Promise<Destination | undefined> {
        const email = await emailSender(job);
        if (email !== undefined && isAllowed(email.account.allow, email.sender)) {
            return { account: email.account.name, recipient: email.sender, replyTo: "job" };
        }
        const notice = deps.notice();
        if (notice === undefined || !canSend(accountNamed(notice.from))) return undefined;
        return { account: notice.from, recipient: notice.to, replyTo: "notice" };
    }

    // A question to the notice address replies to the job's first one there, once that one is composed.
    async function noticeHeaders(job: Job, recipient: string) {
        const rows = await outboxRowsOf(jobStore, job.id, ALL_STATES);
        const first = rows
            .filter((row) => row.kind === "question" && row.recipients.some((to) => to.toLowerCase() === recipient))
            .sort((a, b) => questionNumber(a) - questionNumber(b))[0];
        return { inReplyTo: first?.messageId ?? null, references: first?.messageId ?? null };
    }

    // The subject of the email that started the job, when it came by email.
    async function subjectOf(job: Job): Promise<{ startingSubject?: string }> {
        const subject = job.mailAccount === undefined ? undefined : (await emailsOf(job.id))[0]?.subject;
        return subject === null || subject === undefined ? {} : { startingSubject: subject };
    }

    async function forBlock({ job, author, mailText }: MailAsk): Promise<MailDecision> {
        if (author.kind !== "agent") return { kind: "none" };
        const destination = await blockDestination(job);
        if (destination === undefined) return { kind: "none" };
        if (isBlank(mailText)) return { kind: "mail_text_required" };
        const newest = await jobStore.readMail((tx) => tx.newestQuestion(job.id));
        if (newest?.mailText === mailText) return { kind: "none" };
        const subject = questionSubject({ mailText, ...(await subjectOf(job)) });
        const headers =
            destination.replyTo === "job"
                ? headersOf(await emailsOf(job.id))
                : await noticeHeaders(job, destination.recipient.toLowerCase());
        const row: OwedMail = {
            key: `question:${job.id}:${(await blockCount(jobStore, job)) + 1}`,
            account: destination.account,
            kind: "question",
            recipients: [destination.recipient],
            subject,
            mailText,
            ...headers,
        };
        return { kind: "owe", row };
    }

    function withoutMailText(author: JobAuthor): MailDecision {
        if (author.kind === "agent") return { kind: "mail_text_required" };
        return author.kind === "team_member" ? { kind: "not_sent" } : { kind: "none" };
    }

    async function forComplete({ job, author, mailText }: MailAsk): Promise<MailDecision> {
        if (job.requestMark !== "true") return { kind: "none" };
        const email = await emailSender(job);
        if (email === undefined) return { kind: "none" };
        if (isBlank(mailText)) return withoutMailText(author);
        const row: OwedMail = {
            key: `result:${job.id}`,
            account: email.account.name,
            kind: "result",
            recipients: [email.sender],
            subject: questionSubject({ mailText, ...(await subjectOf(job)) }),
            mailText,
            ...headersOf(await emailsOf(job.id)),
        };
        return { kind: "owe", row };
    }

    async function receivedEntry(row: MailMessageRow, account: MailAccount | undefined) {
        const parsed = row.raw === null ? undefined : await parseMessage(row.raw);
        const addressed = [...(parsed?.to ?? []), ...(parsed?.cc ?? [])];
        const fallback = account === undefined ? [] : [account.address];
        return {
            direction: "received" as const,
            sender: row.sender ?? "",
            recipients: addressed.length === 0 ? fallback : addressed,
            subject: row.subject ?? "",
            date: row.date,
        };
    }

    async function sentEntry(row: OutboxRow) {
        const parsed = row.raw === null ? undefined : await parseMessage(row.raw);
        return {
            direction: "sent" as const,
            sender: accountNamed(row.account ?? undefined)?.address ?? "",
            recipients: row.recipients,
            subject: row.subject ?? "",
            date: parsed?.date ?? null,
        };
    }

    async function emailDetails(job: Job): Promise<JobEmail | undefined> {
        const emails = await emailsOf(job.id);
        const first = emails[0];
        if (job.mailAccount === undefined || first === undefined) return undefined;
        const account = accountNamed(job.mailAccount);
        const stored = first.attachments as { filename: string | null; size: number }[];
        const paths = savedCopyPaths(
            deps.mailDir,
            first.id,
            stored.map((attachment) => attachment.filename),
        );
        const thread = [
            ...(await Promise.all(emails.map((row) => receivedEntry(row, account)))),
            ...(await Promise.all((await outboxRowsOf(jobStore, job.id, THREAD_STATES)).map(sentEntry))),
        ].sort(byDate);
        return {
            account: job.mailAccount,
            sender: first.sender ?? "",
            subject: first.subject ?? "",
            message: {
                path: paths.message,
                attachments: stored.map((attachment, index) => ({
                    name: attachment.filename ?? basename(paths.attachments[index] as string),
                    size: attachment.size,
                    path: paths.attachments[index] as string,
                })),
            },
            thread,
        };
    }

    return { forBlock, forComplete, emailDetails, committed: () => deps.committed?.() };
}

export type OutboxPoint = "mail-sending" | "mail-sent";

export type OutboxDeps = {
    jobStore: JobStore;
    /** The configured accounts, read at each send so a change to the file is seen. */
    accounts: () => readonly MailAccount[];
    notice: () => MailNotice | undefined;
    credential(account: MailAccount): Promise<Credential>;
    /** Whether the account is `ready`: an account in any other status sends nothing. */
    isReady(name: string): boolean;
    /** The server failed before taking a message: the account turns `failing` and is `ready` again by its retry. */
    fail(name: string, message: string): void;
    logger: Logger;
    afterWrite?: (point: OutboxPoint) => Promise<void>;
};

/** One email an agent's `mail_send` call writes: its row is keyed by the conversation and the tool call. */
export type ToolMail = {
    conversationId: string;
    callId: string;
    role: string;
    job: string;
    account: string;
    to: string[];
    subject: string;
    text: string;
    attachments: ComposeAttachment[];
    inReplyTo?: string;
    references?: string[];
};

/** What became of a tool's email; a repeated call returns the same kind from its row. */
export type ToolSendResult =
    | { kind: "sent"; messageId: string; to: string[] }
    | { kind: "waiting" }
    | { kind: "held_back"; notAllowed: string[] }
    | { kind: "refused"; answer: string }
    | { kind: "unknown" }
    | { kind: "not_sent" };

export type Outbox = {
    /** Why the account can't send a tool's email, or undefined when it can: checked before any connection. */
    refusalFor(account: string): string | undefined;
    /** Sends a tool's email once, then copies it to the account's Sent folder. */
    sendFromTool(mail: ToolMail): Promise<ToolSendResult>;
    /** Wakes every started sender, after a commit that adds an owed row. */
    wake(): void;
    /** Starts the account's sender, which at once takes the account's owed rows. The account is `ready`. */
    startAccount(account: MailAccount): void;
    /** Ends the account's sender after the send in flight. */
    stopAccount(name: string): void;
    /** Ends every sender and waits for the sends in flight, within the stop bound. */
    stopAll(): Promise<void>;
};

const STOP_BOUND_MS = 10_000;
const DAEMON_AUTHOR: JobAuthor = { kind: "daemon" };

type Sender = { name: string; isStopped: boolean; isQueued: boolean };

// The servers of these hosts file what is submitted over SMTP in Sent themselves.
const FILING_IMAP_HOSTS: readonly string[] = ["imap.gmail.com", "outlook.office365.com"];

export const skipsSentCopy = (imapHost: string): boolean => FILING_IMAP_HOSTS.includes(imapHost.toLowerCase());

const TOOL_PREFIX = "tool:";

// A tool row's kind is `tool:<role>` and its key `tool:<conversationId>:<toolCallId>`, so its `sent` entry has the
// agent as author even when the sender sends it after a restart.
const authorOf = (row: OutboxRow): JobAuthor =>
    row.kind.startsWith(TOOL_PREFIX)
        ? {
              kind: "agent",
              conversationId: row.key.slice(TOOL_PREFIX.length, row.key.indexOf(":", TOOL_PREFIX.length)),
              role: row.kind.slice(TOOL_PREFIX.length),
          }
        : DAEMON_AUTHOR;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const REFERENCE_PATTERN = /<[^<>\s]+>/g;

const referencesOf = (references: string | null): string[] | undefined =>
    references?.match(REFERENCE_PATTERN) ?? undefined;

export function createOutbox(deps: OutboxDeps): Outbox {
    const { jobStore, logger } = deps;
    const senders = new Map<string, Sender>();
    // The newest pass of each account by name, so a sender started again waits for the one before it.
    const tails = new Map<string, Promise<void>>();

    const accountNamed = (name: string) => deps.accounts().find((account) => account.name === name);

    const wentToNotice = (row: OutboxRow): boolean => {
        const notice = deps.notice();
        return notice !== undefined && row.recipients.some((to) => sameAddress(to, notice.to));
    };

    // The row of a notice to the notice address, owed in the transaction that writes what it tells; none without one.
    async function oweNotice(tx: MailTx, row: OutboxRow, text: MailNoticeText, key: string) {
        const notice = deps.notice();
        const from = notice === undefined ? undefined : accountNamed(notice.from);
        if (notice === undefined || from === undefined) return;
        const owed: NewOutboxRow = {
            key,
            job: row.job,
            account: from.name,
            kind: "notice",
            recipients: [notice.to],
            subject: text.subject,
            mailText: text.text,
            inReplyTo: null,
            references: null,
        };
        await tx.insertOutbox(owed);
    }

    async function writeHeldBack(tx: MailTx, row: OutboxRow, account: MailAccount, notAllowed: string[]) {
        const subject = row.subject ?? "";
        await tx.setOutboxState(row.id, "held_back");
        const entry = {
            mail: "held_back" as const,
            from: account.address,
            to: row.recipients,
            subject,
            notAllowed,
        };
        await tx.addMailHistory(row.job, entry, DAEMON_AUTHOR);
        await oweNotice(
            tx,
            row,
            heldBackNotice({ account: account.name, recipients: notAllowed, subject }),
            `notice:${row.id}`,
        );
    }

    const holdBack = (row: OutboxRow, account: MailAccount, notAllowed: string[]): Promise<void> =>
        jobStore.writeMail((tx) => writeHeldBack(tx, row, account, notAllowed));

    async function markSending(row: OutboxRow, account: MailAccount): Promise<{ raw: Uint8Array }> {
        // A row that was sent once before goes out again as the same bytes, under its Message-ID and its thread row.
        if (row.raw !== null) {
            await jobStore.writeMail((tx) => tx.setOutboxState(row.id, "sending"));
            await deps.afterWrite?.("mail-sending");
            return { raw: row.raw };
        }
        const composed = await composeMessage({
            from: account.address,
            to: row.recipients,
            subject: row.subject ?? "",
            text: row.mailText ?? "",
            ...(row.inReplyTo !== null && { inReplyTo: row.inReplyTo }),
            ...(referencesOf(row.references) !== undefined && { references: referencesOf(row.references) as string[] }),
        });
        await jobStore.writeMail(async (tx) => {
            await tx.setOutboxState(row.id, "sending", { messageId: composed.messageId, raw: composed.raw });
            await tx.addThread({ messageId: composed.messageId, job: row.job, direction: "out" });
        });
        await deps.afterWrite?.("mail-sending");
        return { raw: composed.raw };
    }

    // Writes the refusals of a server: the `refused` entry with the answers and, unless the row went to the notice address, one notice.
    async function writeRefusal(
        tx: MailTx,
        row: OutboxRow,
        account: MailAccount,
        refused: { addresses: string[]; answer: string },
    ) {
        const subject = row.subject ?? "";
        const entry = {
            mail: "refused" as const,
            from: account.address,
            to: refused.addresses,
            subject,
            serverAnswer: refused.answer,
        };
        await tx.addMailHistory(row.job, entry, DAEMON_AUTHOR);
        if (wentToNotice(row)) return;
        const text = refusedNotice({
            account: account.name,
            recipients: refused.addresses,
            subject,
            serverAnswer: refused.answer,
        });
        await oweNotice(tx, row, text, `refused:${row.id}`);
    }

    async function record(row: OutboxRow, account: MailAccount, outcome: SmtpOutcome): Promise<void> {
        const subject = row.subject ?? "";
        if (outcome.kind === "sent") {
            await jobStore.writeMail(async (tx) => {
                await tx.setOutboxState(row.id, "sent");
                const entry = { mail: "sent" as const, from: account.address, to: outcome.accepted, subject };
                await tx.addMailHistory(row.job, entry, authorOf(row));
                if (outcome.refused.length === 0) return;
                const addresses = outcome.refused.map((refusal) => refusal.address);
                const answer = outcome.refused.map((refusal) => refusal.answer).join("; ");
                await writeRefusal(tx, row, account, { addresses, answer });
            });
            await deps.afterWrite?.("mail-sent");
        } else if (outcome.kind === "unknown") {
            await jobStore.writeMail(async (tx) => {
                await tx.setOutboxState(row.id, "may_not_have_gone_out");
                const entry = {
                    mail: "may_not_have_gone_out" as const,
                    from: account.address,
                    to: row.recipients,
                    subject,
                };
                await tx.addMailHistory(row.job, entry, DAEMON_AUTHOR);
            });
        } else if (outcome.kind === "refused") {
            await jobStore.writeMail(async (tx) => {
                await tx.setOutboxState(row.id, "refused", { serverAnswer: outcome.answer });
                await writeRefusal(tx, row, account, { addresses: row.recipients, answer: outcome.answer });
            });
        }
    }

    // Sends the bytes of a row that is `sending`. A failure before the server took them puts the row back to `owed`.
    async function deliver(row: OutboxRow, account: MailAccount, raw: Uint8Array): Promise<SmtpOutcome> {
        const outcome = await sendRaw({
            host: account.smtpHost as string,
            port: account.smtpPort as number,
            security: account.smtpSecurity,
            credential: await deps.credential(account),
            envelope: { from: account.address, to: row.recipients },
            raw,
        });
        if (outcome.kind === "not_taken") {
            await jobStore.writeMail((tx) => tx.setOutboxState(row.id, "owed"));
            deps.fail(account.name, outcome.message);
        } else {
            await record(row, account, outcome);
        }
        return outcome;
    }

    // Sends one row. Returns false when the pass must stop: the server failed before taking the message.
    async function send(row: OutboxRow, account: MailAccount): Promise<boolean> {
        const notAllowed = notAllowedRecipients(account, row.recipients, deps.notice()?.to);
        if (notAllowed.length > 0) {
            await holdBack(row, account, notAllowed);
            return true;
        }
        const { raw } = await markSending(row, account);
        const outcome = await deliver(row, account, raw);
        return outcome.kind !== "not_taken";
    }

    async function appendToSent(account: MailAccount, row: { messageId: string; raw: Uint8Array }): Promise<void> {
        const imap = await openImap({
            host: account.imapHost,
            port: account.imapPort,
            security: account.imapSecurity,
            credential: await deps.credential(account),
            idleSeconds: account.checkIntervalSeconds,
        });
        try {
            const folder = await imap.specialFolder("sent");
            if (folder === undefined) throw new Error(`The account ${account.name} has no Sent folder.`);
            if (!(await imap.hasMessageId(folder, row.messageId))) await imap.append(folder, row.raw, ["\\Seen"]);
        } finally {
            await imap.logout();
        }
    }

    // One copy of a sent tool email in the account's Sent folder, then the `copied` mark. A failed copy leaves the mark
    // off: the next pass of a ready account tries again, and the send itself stands.
    const copying = new Set<string>();
    async function copyToSent(key: string, account: MailAccount): Promise<void> {
        const row = await jobStore.readMail((tx) => tx.outboxByKey(key));
        if (row?.copied !== false || row.messageId === null || row.raw === null || copying.has(row.id)) return;
        copying.add(row.id);
        try {
            if (!skipsSentCopy(account.imapHost))
                await appendToSent(account, { messageId: row.messageId, raw: row.raw });
            await jobStore.writeMail((tx) => tx.setOutboxState(row.id, "sent", { copied: true }));
        } catch (error) {
            const cause = error instanceof Error ? error.message : "the copy failed";
            logger.error("mail copy to Sent failed", { account: account.name, cause });
        } finally {
            copying.delete(row.id);
        }
    }

    async function copyPending(account: MailAccount): Promise<void> {
        const sent = await jobStore.readMail((tx) => tx.rowsInState("sent", account.name));
        for (const row of sent) if (row.copied === false) await copyToSent(row.key, account);
    }

    async function sendOwed(sender: Sender): Promise<void> {
        while (!sender.isStopped && deps.isReady(sender.name)) {
            const account = accountNamed(sender.name);
            if (account?.smtpHost === undefined) return;
            const [row] = await jobStore.readMail((tx) => tx.owedRows(sender.name));
            if (row === undefined) return;
            if (!(await send(row, account))) return;
            // The notice a row owed may belong to another account's sender.
            wake();
        }
    }

    async function pass(sender: Sender): Promise<void> {
        await sendOwed(sender);
        const account = accountNamed(sender.name);
        if (account === undefined || sender.isStopped || !deps.isReady(sender.name)) return;
        await copyPending(account);
    }

    function enqueue(sender: Sender): void {
        if (sender.isQueued) return;
        sender.isQueued = true;
        const next = (tails.get(sender.name) ?? Promise.resolve()).then(async () => {
            sender.isQueued = false;
            await pass(sender);
        });
        tails.set(
            sender.name,
            next.catch((error: unknown) => {
                const message = error instanceof Error ? error.message : "the send failed";
                logger.error("mail sender failed", { account: sender.name, cause: message });
                deps.fail(sender.name, message);
            }),
        );
    }

    function wake(): void {
        for (const sender of senders.values()) enqueue(sender);
    }

    function stopAccount(name: string): void {
        const sender = senders.get(name);
        if (sender === undefined) return;
        sender.isStopped = true;
        senders.delete(name);
    }

    function resultOfRow(row: OutboxRow): ToolSendResult {
        switch (row.state) {
            case "owed":
                return { kind: "waiting" };
            case "sent":
                return { kind: "sent", messageId: row.messageId ?? "", to: row.recipients };
            case "held_back": {
                const account = accountNamed(row.account ?? "");
                const notAllowed =
                    account === undefined
                        ? row.recipients
                        : notAllowedRecipients(account, row.recipients, deps.notice()?.to);
                return { kind: "held_back", notAllowed };
            }
            case "refused":
                return { kind: "refused", answer: row.serverAnswer ?? "" };
            case "account_removed":
                return { kind: "not_sent" };
            default:
                return { kind: "unknown" };
        }
    }

    function refusalFor(name: string): string | undefined {
        const account = accountNamed(name);
        if (account === undefined) return `There is no mail account named "${name}".`;
        if (account.kind === "monitored") return `The mail account "${name}" is monitored: it never sends.`;
        if (account.smtpHost === undefined) return `The mail account "${name}" has no SMTP host to send through.`;
        return undefined;
    }

    async function sendFromTool(mail: ToolMail): Promise<ToolSendResult> {
        const key = `${TOOL_PREFIX}${mail.conversationId}:${mail.callId}`;
        const existing = await jobStore.readMail((tx) => tx.outboxByKey(key));
        if (existing !== undefined) return resultOfRow(existing);
        const account = accountNamed(mail.account) as MailAccount;
        const owed: NewOutboxRow = {
            key,
            job: mail.job,
            account: account.name,
            kind: `${TOOL_PREFIX}${mail.role}`,
            recipients: mail.to,
            subject: mail.subject,
            mailText: mail.text,
            inReplyTo: mail.inReplyTo ?? null,
            references: mail.references?.join(" ") ?? null,
        };
        const notAllowed = notAllowedRecipients(account, mail.to, deps.notice()?.to);
        if (notAllowed.length > 0) {
            await jobStore.writeMail(async (tx) => writeHeldBack(tx, await tx.insertOutbox(owed), account, notAllowed));
            wake();
            return { kind: "held_back", notAllowed };
        }
        const composed = await composeMessage({
            from: account.address,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            attachments: mail.attachments,
            ...(mail.inReplyTo !== undefined && { inReplyTo: mail.inReplyTo }),
            ...(mail.references !== undefined && { references: mail.references }),
        });
        const row = await jobStore.writeMail(async (tx) => {
            const inserted = await tx.insertOutbox(owed);
            const written = { messageId: composed.messageId, raw: composed.raw, copied: false };
            await tx.setOutboxState(inserted.id, "sending", written);
            await tx.addThread({ messageId: composed.messageId, job: mail.job, direction: "out" });
            return inserted;
        });
        await deps.afterWrite?.("mail-sending");
        const outcome = await deliver(row, account, composed.raw);
        if (outcome.kind === "not_taken") return { kind: "waiting" };
        if (outcome.kind === "refused") return { kind: "refused", answer: outcome.answer };
        if (outcome.kind === "unknown") return { kind: "unknown" };
        await copyToSent(key, account);
        return { kind: "sent", messageId: composed.messageId, to: row.recipients };
    }

    return {
        refusalFor,
        sendFromTool,
        wake,
        startAccount(account) {
            const sender = senders.get(account.name) ?? { name: account.name, isStopped: false, isQueued: false };
            senders.set(account.name, sender);
            enqueue(sender);
        },
        stopAccount,
        async stopAll() {
            for (const name of [...senders.keys()]) stopAccount(name);
            let timer: NodeJS.Timeout | undefined;
            const bound = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, STOP_BOUND_MS);
            });
            await Promise.race([Promise.all(tails.values()), bound]);
            clearTimeout(timer);
        },
    };
}
