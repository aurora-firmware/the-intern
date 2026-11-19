import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import PostalMime, { type Address } from "postal-mime";
import { htmlToText } from "./html_text.ts";

export type ParsedAttachment = {
    filename: string | null;
    contentType: string;
    size: number;
    content: Uint8Array;
};

export type ParsedMessage = {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: string | null;
    to: string[];
    cc: string[];
    subject: string;
    date: string | null;
    text: string;
    attachments: ParsedAttachment[];
};

export type ComposeAttachment = { filename: string; contentType: string; content: Uint8Array };

export type ComposeInput = {
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    attachments?: ComposeAttachment[];
    inReplyTo?: string;
    references?: string[];
};

const addressesOf = (addresses: Address[] | undefined): string[] =>
    (addresses ?? []).flatMap((entry) =>
        entry.group === undefined ? [entry.address] : entry.group.map((m) => m.address),
    );

const bytesOf = (content: string | ArrayBuffer | Uint8Array): Uint8Array =>
    typeof content === "string" ? Buffer.from(content, "utf8") : new Uint8Array(content);

const REFERENCE_PATTERN = /<[^<>\s]+>/g;

export const parseMessage = async (raw: Uint8Array | string): Promise<ParsedMessage> => {
    const email = await PostalMime.parse(raw);
    const text = email.text ?? (email.html === undefined ? "" : htmlToText(email.html));
    return {
        messageId: email.messageId ?? null,
        inReplyTo: email.inReplyTo ?? null,
        references: email.references?.match(REFERENCE_PATTERN) ?? [],
        from: addressesOf(email.from === undefined ? undefined : [email.from])[0] ?? null,
        to: addressesOf(email.to),
        cc: addressesOf(email.cc),
        subject: email.subject ?? "",
        date: email.date ?? null,
        text,
        attachments: email.attachments.map((attachment) => {
            const content = bytesOf(attachment.content);
            return {
                filename: attachment.filename,
                contentType: attachment.mimeType,
                size: content.byteLength,
                content,
            };
        }),
    };
};

const domainOf = (address: string): string => {
    const at = address.lastIndexOf("@");
    if (at < 0 || at === address.length - 1) {
        throw new Error(`Cannot compose a message from "${address}": the sender address has no domain.`);
    }
    return address.slice(at + 1);
};

/** Composes a message once; the same bytes go to SMTP, to Sent and to Drafts. */
export const composeMessage = async (input: ComposeInput): Promise<{ raw: Buffer; messageId: string }> => {
    const messageId = `<${randomUUID()}@${domainOf(input.from)}>`;
    const composer = new MailComposer({
        from: input.from,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        text: input.text,
        messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments?.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: Buffer.from(attachment.content),
        })),
        disableFileAccess: true,
        disableUrlAccess: true,
    });
    const raw = await composer.compile().build();
    return { raw, messageId };
};
