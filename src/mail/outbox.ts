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
import { composeMessage, parseMessage } from "./mime.ts";
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

export type Outbox = {
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

    async function holdBack(row: OutboxRow, account: MailAccount, notAllowed: string[]): Promise<void> {
        const subject = row.subject ?? "";
        await jobStore.writeMail(async (tx) => {
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
        });
    }

    async function markSending(row: OutboxRow, account: MailAccount): Promise<{ raw: Buffer }> {
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
                await tx.addMailHistory(row.job, entry, DAEMON_AUTHOR);
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

    // Sends one row. Returns false when the pass must stop: the server failed before taking the message.
    async function send(row: OutboxRow, account: MailAccount): Promise<boolean> {
        const notAllowed = notAllowedRecipients(account, row.recipients, deps.notice()?.to);
        if (notAllowed.length > 0) {
            await holdBack(row, account, notAllowed);
            return true;
        }
        const credential = await deps.credential(account);
        const { raw } = await markSending(row, account);
        const outcome = await sendRaw({
            host: account.smtpHost as string,
            port: account.smtpPort as number,
            security: account.smtpSecurity,
            credential,
            envelope: { from: account.address, to: row.recipients },
            raw,
        });
        if (outcome.kind === "not_taken") {
            await jobStore.writeMail((tx) => tx.setOutboxState(row.id, "owed"));
            deps.fail(account.name, outcome.message);
            return false;
        }
        await record(row, account, outcome);
        return true;
    }

    async function pass(sender: Sender): Promise<void> {
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

    return {
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
