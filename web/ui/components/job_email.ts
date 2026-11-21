/**
 * The Job page's email section (S-009 REQ-018, S-006 REQ-003): what `jobs.get` returns of a job that came by email.
 * Each attachment shows its name and size and nothing else: no route or operation sends one to a browser.
 */
import { h } from "preact";
import { Field, type JobRecord } from "./job_record.ts";

export type EmailDetails = {
    account: string;
    sender: string;
    subject: string;
    message: { path: string; attachments: { name: string; size: number; path: string }[] } | null;
    thread: {
        direction: "received" | "sent";
        sender: string;
        recipients: string[];
        subject: string;
        date: string | null;
    }[];
};

/** A job as `jobs.get` returns it: the record, with the request's text and, for a job by email, its details and mark. */
export type EmailJobRecord = Omit<JobRecord, "request"> & {
    request: JobRecord["request"] & { text?: string };
    email?: EmailDetails;
    requestMark?: string;
};

const LIST_STYLE = "display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none;";

type Thread = EmailDetails["thread"][number];

const threadText = (entry: Thread): string =>
    [
        entry.direction,
        `from ${entry.sender}`,
        `to ${entry.recipients.join(", ")}`,
        entry.subject,
        entry.date ?? "no date",
    ].join(", ");

/** The email details of a job that came by email, or nothing for any other job. */
export const JobEmail = ({ record }: { record: EmailJobRecord }) => {
    const { email } = record;
    if (email === undefined) return null;
    return h(
        "section",
        { class: "card job-email", "data-section": "email" },
        h("h3", null, "Email"),
        h(Field, { name: "account", label: "Mail account", value: email.account }),
        h(Field, { name: "sender", label: "Sender", value: email.sender }),
        h(Field, { name: "subject", label: "Subject", value: email.subject }),
        h(Field, { name: "message", label: "Saved message", value: record.request.text ?? "" }),
        h(Field, {
            name: "request-mark",
            label: "Request mark",
            value: record.requestMark === "true" ? "Set" : "Not set",
        }),
        h(
            "div",
            { class: "job-field", "data-field": "attachments" },
            h("h3", null, "Attachments"),
            h(
                "ul",
                { style: LIST_STYLE },
                ...(email.message?.attachments ?? []).map((attachment, index) =>
                    h("li", { class: "job-attachment", key: index }, `${attachment.name}, ${attachment.size} bytes`),
                ),
            ),
        ),
        h(
            "div",
            { class: "job-field", "data-field": "thread" },
            h("h3", null, "Job thread"),
            h(
                "ul",
                { style: LIST_STYLE },
                ...email.thread.map((entry, index) =>
                    h("li", { class: "job-thread-entry", key: index }, threadText(entry)),
                ),
            ),
        ),
    );
};
