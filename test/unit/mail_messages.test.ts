import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    heldBackNotice,
    MAIL_HEADERS,
    questionSubject,
    refusedNotice,
    requestText,
    routeFor,
    threadParentOf,
} from "../../src/mail/mail_model.ts";

const knownIds =
    (...ids: string[]) =>
    (messageId: string) =>
        ids.includes(messageId);

describe("threadParentOf", () => {
    it("picks_in_reply_to_before_any_references_entry", () => {
        const parent = threadParentOf(
            { inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>", "<c@x>"] },
            knownIds("<a@x>", "<b@x>", "<c@x>"),
        );
        assert.equal(parent, "<b@x>");
    });

    it("picks_the_newest_known_references_entry_when_in_reply_to_is_unknown", () => {
        const parent = threadParentOf(
            { inReplyTo: "<zz@x>", references: ["<a@x>", "<b@x>", "<c@x>"] },
            knownIds("<a@x>", "<b@x>"),
        );
        assert.equal(parent, "<b@x>");
    });

    it("picks_the_newest_known_references_entry_when_in_reply_to_is_missing", () => {
        const parent = threadParentOf({ references: ["<a@x>", "<b@x>"] }, knownIds("<a@x>", "<b@x>"));
        assert.equal(parent, "<b@x>");
    });

    it("returns_undefined_when_no_message_id_is_known", () => {
        assert.equal(threadParentOf({ inReplyTo: "<q@x>", references: ["<r@x>"] }, knownIds()), undefined);
        assert.equal(threadParentOf({}, knownIds("<a@x>")), undefined);
    });
});

describe("routeFor", () => {
    it("routes_an_email_with_no_job_new", () => {
        assert.equal(routeFor(undefined), "new");
    });

    it("routes_an_email_whose_job_is_done_related", () => {
        assert.equal(routeFor("done"), "related");
    });

    it("routes_an_email_whose_job_is_not_done_input", () => {
        for (const status of ["to_do", "in_progress", "blocked"] as const) {
            assert.equal(routeFor(status), "input");
        }
    });
});

describe("questionSubject", () => {
    it("uses_the_subject_of_the_starting_email_unchanged", () => {
        const subject = questionSubject({ startingSubject: "  Re: Server  list ", mailText: "Which one?" });
        assert.equal(subject, "  Re: Server  list ");
    });

    it("uses_the_first_line_of_the_mail_text_for_a_job_without_an_email", () => {
        const subject = questionSubject({ mailText: "Which server do you mean?\nThe staging one?" });
        assert.equal(subject, "Which server do you mean?");
    });
});

describe("requestText", () => {
    it("holds_the_sender_subject_date_text_and_saved_paths", () => {
        const text = requestText({
            sender: "ana@example.com",
            subject: "Server list",
            date: "Tue, 3 Nov 2026 10:00:00 +0000",
            text: "Please list the servers.",
            messagePath: "/data/mail/1/message.eml",
            attachmentPaths: ["/data/mail/1/a.pdf", "/data/mail/1/b.txt"],
        });
        for (const part of [
            "ana@example.com",
            "Server list",
            "Tue, 3 Nov 2026 10:00:00 +0000",
            "Please list the servers.",
            "/data/mail/1/message.eml",
            "/data/mail/1/a.pdf",
            "/data/mail/1/b.txt",
        ]) {
            assert.ok(text.includes(part), `missing ${part}`);
        }
    });

    it("lists_no_attachments_when_there_are_none", () => {
        const text = requestText({
            sender: "ana@example.com",
            subject: "Hi",
            date: "today",
            text: "Body",
            messagePath: "/m/message.eml",
            attachmentPaths: [],
        });
        assert.ok(text.includes("/m/message.eml"));
        assert.ok(/no attachments/i.test(text));
    });
});

const INTERNALS = /[CWESA]-[0-9]+|\/|\b(triage|lead|send_mail|jobs?|conversation|request)\b/i;

describe("notices", () => {
    it("names_the_account_recipients_and_subject_of_a_held_back_email", () => {
        const notice = heldBackNotice({
            account: "intern",
            recipients: ["bo@other.org", "cy@other.org"],
            subject: "Server list",
        });
        const both = `${notice.subject}\n${notice.text}`;
        for (const part of ["intern", "bo@other.org", "cy@other.org", "Server list"]) {
            assert.ok(both.includes(part), `missing ${part}`);
        }
        assert.doesNotMatch(both, INTERNALS);
    });

    it("names_the_account_recipients_subject_and_server_answer_of_a_refused_email", () => {
        const notice = refusedNotice({
            account: "intern",
            recipients: ["nobody@example.com"],
            subject: "Server list",
            serverAnswer: "550 5.1.1 User unknown",
        });
        const both = `${notice.subject}\n${notice.text}`;
        for (const part of ["intern", "nobody@example.com", "Server list", "550 5.1.1 User unknown"]) {
            assert.ok(both.includes(part), `missing ${part}`);
        }
        assert.doesNotMatch(both, INTERNALS);
    });
});

describe("MAIL_HEADERS", () => {
    it("holds_exactly_the_headers_the_daemon_may_write", () => {
        assert.deepEqual(
            [...MAIL_HEADERS],
            [
                "From",
                "To",
                "Subject",
                "Date",
                "Message-ID",
                "In-Reply-To",
                "References",
                "MIME-Version",
                "Content-Type",
                "Content-Transfer-Encoding",
                "Content-Disposition",
                "Content-ID",
            ],
        );
    });
});
