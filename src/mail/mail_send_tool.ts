/**
 * The send tool (S-009 REQ-010, REQ-011, REQ-012, REQ-022): `mail_send` writes its email as an outbox row keyed by the
 * tool call, so the same call acts once, and the outbox sends it and files its copy in the Sent folder.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { readConversationMeta } from "../host/seating.ts";
import { readAttachments } from "./mail_sort_tools.ts";
import {
    accountField,
    jsonResult,
    type MailToolsOptions,
    messageFields,
    readParsed,
    refOf,
    refusable,
    textResult,
} from "./mail_tool_support.ts";
import type { ToolSendResult } from "./outbox.ts";
import { MailToolRefusal } from "./tool_connection.ts";

const WAITS = "The server did not take the email yet. It waits for the server and goes out once the account is ready.";

function resultOf(result: ToolSendResult) {
    switch (result.kind) {
        case "sent":
            return jsonResult({ sent: true, messageId: result.messageId, to: result.to });
        case "waiting":
            return textResult(WAITS);
        case "held_back":
            return textResult(
                `mail_send was refused: nothing was sent, because the allowlist doesn't allow ${result.notAllowed.join(", ")}.`,
                true,
            );
        case "refused":
            return textResult(`mail_send was refused by the server: ${result.answer}`, true);
        case "not_sent":
            return textResult("The email was not sent: the account was removed.", true);
        case "unknown":
            return textResult(
                "The email may not have gone out: the connection was lost before the server answered. Look in the " +
                    "Sent folder before sending it again.",
            );
    }
}

export const sendTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_send",
        description:
            "Send a plain-text email from an owned mail account, optionally as a reply to a message and with files of " +
            "yours attached (a relative path is relative to your workspace). Only addresses the account's allowlist " +
            "allows get it. The same call again sends nothing more.",
        parameters: Type.Object({
            account: accountField,
            to: Type.Array(Type.String(), { minItems: 1, description: "The recipients' addresses." }),
            subject: Type.String(),
            text: Type.String({ description: "The plain text of the message." }),
            attachments: Type.Optional(Type.Array(Type.String(), { description: "Paths of files to attach." })),
            replyTo: Type.Optional(
                Type.Object(
                    { folder: messageFields.folder, uidValidity: messageFields.uidValidity, uid: messageFields.uid },
                    { description: "The message of the same account this email replies to." },
                ),
            ),
        }),
        async execute(args, api: ToolExecutionApi) {
            return refusable("mail_send", async () => {
                const host = options.host();
                const outbox = options.outbox();
                if (host === undefined || outbox === undefined) {
                    throw new MailToolRefusal("Mail is not started yet; try again in a moment.");
                }
                const refusal = outbox.refusalFor(args.account);
                if (refusal !== undefined) throw new MailToolRefusal(refusal);
                const conversationId = String(api.conversationId);
                const meta = await readConversationMeta(host, conversationId);
                if (meta === undefined) throw new Error(`Conversation ${conversationId} has no job.`);
                const attachments = await readAttachments(api.env?.cwd, args.attachments ?? []);
                const original =
                    args.replyTo === undefined
                        ? undefined
                        : await options
                              .connections()
                              .use(args.account, (imap) => readParsed(imap, refOf(args.replyTo as never)));
                const result = await outbox.sendFromTool({
                    conversationId,
                    callId: api.callId,
                    role: meta.seat.role,
                    job: meta.jobId as string,
                    account: args.account,
                    to: args.to,
                    subject: args.subject,
                    text: args.text,
                    attachments,
                    ...(original?.messageId && {
                        inReplyTo: original.messageId,
                        references: [...original.references, original.messageId],
                    }),
                });
                return resultOf(result);
            });
        },
    });
