/**
 * The mail policy the mail component registers with the jobs component (S-009 REQ-014, REQ-015; S-004 REQ-014): the
 * mail a block or a completion owes, and the email details `jobs.get` returns. It reads through the job store's mail
 * transaction and never writes; the job write inserts the owed row it returns.
 */
import { basename } from "node:path";
import type { JobAuthor } from "../jobs/job_model.ts";
import type { Job, JobStore } from "../jobs/job_store.ts";
import type { JobEmail, MailAsk, MailDecision, MailPolicy, OwedMail } from "../jobs/mail_policy.ts";
import { isAllowed, type MailAccount, type MailNotice, questionSubject } from "./mail_model.ts";
import type { MailMessageRow, OutboxRow, OutboxState } from "./mail_store.ts";
import { parseMessage } from "./mime.ts";
import { savedCopyPaths } from "./saved_copy.ts";

export type MailPolicyDeps = {
    jobStore: JobStore;
    /** The configured accounts, read at each ask so a change to the file is seen. */
    accounts: () => readonly MailAccount[];
    notice: () => MailNotice | undefined;
    mailDir: string;
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

async function outboxRowsOf(jobStore: JobStore, jobId: string, states: readonly OutboxState[]): Promise<OutboxRow[]> {
    return jobStore.readMail(async (tx) => {
        const rows: OutboxRow[] = [];
        for (const state of states) rows.push(...(await tx.rowsInState(state)).filter((row) => row.job === jobId));
        return rows;
    });
}

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

    return { forBlock, forComplete, emailDetails, committed: () => {} };
}
