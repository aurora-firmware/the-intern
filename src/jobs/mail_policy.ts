/**
 * The mail policy the jobs component asks when a job is blocked or completed (S-004 REQ-018; S-009 REQ-014, REQ-015).
 * The jobs component never imports a mail module: the mail component registers a policy on the host, and without
 * one nothing is required or owed.
 */
import type { HarnessHost } from "../host/harness_host.ts";
import type { JobAuthor } from "./job_model.ts";
import type { Job } from "./job_store.ts";

/** One email the job write owes, stored as an outbox row in the same transaction. */
export type OwedMail = {
    key: string;
    account: string;
    kind: "question" | "result";
    recipients: string[];
    subject: string;
    mailText: string;
    inReplyTo: string | null;
    references: string | null;
};

export type MailDecision =
    | { kind: "none" }
    | { kind: "mail_text_required" }
    | { kind: "owe"; row: OwedMail }
    | { kind: "not_sent" };

/** The email details `jobs.get` returns for a job that came by email (S-004 Interfaces). */
export type JobEmail = {
    account: string;
    sender: string;
    subject: string;
    /** The saved message and its attachments, as paths computed at the read. */
    message: { path: string; attachments: { name: string; size: number; path: string }[] } | null;
    thread: {
        direction: "received" | "sent";
        sender: string;
        recipients: string[];
        subject: string;
        date: string | null;
    }[];
};

export type MailAsk = { job: Job; author: JobAuthor; mailText: string | undefined };

export type MailPolicy = {
    forBlock(ask: MailAsk): Promise<MailDecision>;
    forComplete(ask: MailAsk): Promise<MailDecision>;
    emailDetails(job: Job): Promise<JobEmail | undefined>;
    /** Called after the commit of a job write that owes mail, so the sender can take the row. */
    committed(): void;
};

/** A block or completion needs mail text that the caller did not give; nothing was written. */
export class MailTextRequiredError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`Job "${jobId}" needs a mail text: its email is answered with it. Give the mail text and try again.`);
        this.name = "MailTextRequiredError";
        this.jobId = jobId;
    }
}

const mailPolicies = new WeakMap<HarnessHost, MailPolicy>();

/** Registers the mail policy of the host. A new policy replaces the old one. Returns the function that removes it. */
export function setMailPolicy(host: HarnessHost, policy: MailPolicy): () => void {
    mailPolicies.set(host, policy);
    return () => {
        if (mailPolicies.get(host) === policy) mailPolicies.delete(host);
    };
}

/** The host's mail policy, or undefined when there is no mail component. */
export function mailPolicyOf(host: HarnessHost): MailPolicy | undefined {
    return mailPolicies.get(host);
}
