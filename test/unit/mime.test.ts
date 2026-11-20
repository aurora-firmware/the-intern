import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { MAIL_HEADERS } from "../../src/mail/mail_model.ts";
import { composeMessage, parseMessage } from "../../src/mail/mime.ts";

const headerNames = (raw: Buffer): string[] => {
    const head = raw.toString("latin1").split(/\r?\n\r?\n/)[0] ?? "";
    return head
        .split(/\r?\n/)
        .filter((line) => !/^\s/.test(line))
        .map((line) => line.slice(0, line.indexOf(":")));
};

const baseInput = {
    from: "bob@intern.example",
    to: ["ann@example.com", "cy@example.org"],
    subject: "Quarterly figures",
    text: "Hello Ann,\nthe figures are attached.\n",
};

describe("composeMessage and parseMessage", () => {
    it("returns_attachment_bytes_identical_to_the_composed_ones", async () => {
        const pdf = randomBytes(10 * 1024);
        const note = Buffer.from("plain note\r\nwith lines\n", "utf8");
        const { raw } = await composeMessage({
            ...baseInput,
            attachments: [
                { filename: "report.pdf", contentType: "application/pdf", content: pdf },
                { filename: "note.txt", contentType: "text/plain", content: note },
            ],
        });
        const parsed = await parseMessage(raw);
        assert.equal(parsed.attachments.length, 2);
        assert.equal(parsed.attachments[0]?.filename, "report.pdf");
        assert.equal(parsed.attachments[0]?.contentType, "application/pdf");
        assert.equal(parsed.attachments[0]?.size, pdf.length);
        assert.ok(Buffer.from(parsed.attachments[0]?.content ?? []).equals(pdf));
        assert.equal(parsed.attachments[1]?.filename, "note.txt");
        assert.ok(Buffer.from(parsed.attachments[1]?.content ?? []).equals(note));
    });

    it("returns_the_text_of_an_html_only_message_without_script_or_style", async () => {
        const raw = [
            "From: Ann <ann@example.com>",
            "To: bob@intern.example",
            "Subject: Page",
            "Message-ID: <h1@example.com>",
            "MIME-Version: 1.0",
            "Content-Type: text/html; charset=utf-8",
            "",
            "<style>p{}</style><p>Hi &amp; welcome</p><script>evil()</script>",
        ].join("\r\n");
        const parsed = await parseMessage(Buffer.from(raw));
        assert.equal(parsed.text, "Hi & welcome");
        assert.equal(parsed.from, "ann@example.com");
        assert.deepEqual(parsed.to, ["bob@intern.example"]);
    });

    it("writes_reply_headers_a_uuid_message_id_at_the_sender_domain_and_no_other_header", async () => {
        const { raw, messageId } = await composeMessage({
            ...baseInput,
            inReplyTo: "<parent@example.com>",
            references: ["<root@example.com>", "<parent@example.com>"],
        });
        assert.match(messageId, /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@intern\.example>$/);
        const parsed = await parseMessage(raw);
        assert.equal(parsed.messageId, messageId);
        assert.equal(parsed.inReplyTo, "<parent@example.com>");
        assert.deepEqual(parsed.references, ["<root@example.com>", "<parent@example.com>"]);
        const allowed = MAIL_HEADERS.map((name) => name.toLowerCase());
        for (const name of headerNames(raw)) {
            assert.ok(allowed.includes(name.toLowerCase()), `header ${name} is outside MAIL_HEADERS`);
        }
    });

    it("composes_different_message_ids_for_two_messages", async () => {
        const first = await composeMessage(baseInput);
        const second = await composeMessage(baseInput);
        assert.notEqual(first.messageId, second.messageId);
    });

    it("reads_back_the_same_recipients_subject_text_and_attachments", async () => {
        const content = Buffer.from("abc");
        const { raw } = await composeMessage({
            ...baseInput,
            subject: "Grüße, 日本",
            attachments: [{ filename: "a.bin", contentType: "application/octet-stream", content }],
        });
        const parsed = await parseMessage(raw);
        assert.equal(parsed.from, baseInput.from);
        assert.deepEqual(parsed.to, baseInput.to);
        assert.deepEqual(parsed.cc, []);
        assert.equal(parsed.subject, "Grüße, 日本");
        assert.equal(parsed.text.trim(), baseInput.text.trim());
        assert.equal(parsed.attachments.length, 1);
        assert.ok(Buffer.from(parsed.attachments[0]?.content ?? []).equals(content));
    });

    function importersOf(pattern: string): string[] {
        const output = execFileSync("git", ["grep", "-l", "-E", pattern, "--", "src"], { encoding: "utf8" });
        return output.trim().split("\n");
    }

    it("imports_nodemailer_only_in_the_mime_and_smtp_adapters", () => {
        assert.deepEqual(importersOf("nodemailer"), ["src/mail/mime.ts", "src/mail/smtp_client.ts"]);
    });

    it("imports_postal_mime_only_in_the_mime_adapter", () => {
        assert.deepEqual(importersOf("postal-mime"), ["src/mail/mime.ts"]);
    });
});
