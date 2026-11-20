/**
 * The mail tools that sort and draft (S-009 REQ-011, REQ-010): `mail_move`, `mail_set_flags` and `mail_save_draft`.
 * None is replay-safe; a repeat leaves the same end state, or, for a draft, saves nothing more.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { FlagChanges, MessageRef } from "./imap_client.ts";
import {
    accountField,
    jsonResult,
    type MailToolsOptions,
    messageFields,
    readParsed,
    refOf,
    refusable,
    requireFolder,
} from "./mail_tool_support.ts";
import { composeMessage } from "./mime.ts";
import { MailToolRefusal } from "./tool_connection.ts";

const uidsField = Type.Array(Type.Number(), {
    description: "The UIDs of the messages, all in the folder, as mail_search returned them.",
});

function refsOf(args: { folder: string; uidValidity: number; uids: number[] }): MessageRef[] {
    if (args.uids.length === 0) throw new MailToolRefusal("No message was named: uids is empty.");
    return args.uids.map((uid) => ({ folder: args.folder, uidValidity: args.uidValidity, uid }));
}

export const moveTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_move",
        description:
            "Move messages to an existing folder of the account, Trash included. Nothing is deleted for good. " +
            "Moving a message that is already gone from its folder changes nothing.",
        parameters: Type.Object({
            account: accountField,
            folder: messageFields.folder,
            uidValidity: messageFields.uidValidity,
            uids: uidsField,
            target: Type.String({ description: "The existing folder to move the messages to." }),
        }),
        async execute(args) {
            return refusable("mail_move", () =>
                options.connections().use(args.account, async (imap) => {
                    await requireFolder(imap, args.target);
                    await imap.move(refsOf(args), args.target);
                    return jsonResult({ moved: args.uids.length, target: args.target });
                }),
            );
        },
    });

export const setFlagsTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_set_flags",
        description:
            "Set a flag with true or clear it with false; the flags are seen, flagged and answered, and a flag " +
            "left out stays as it is. Name at least one.",
        parameters: Type.Object({
            account: accountField,
            folder: messageFields.folder,
            uidValidity: messageFields.uidValidity,
            uids: uidsField,
            seen: Type.Optional(Type.Boolean()),
            flagged: Type.Optional(Type.Boolean()),
            answered: Type.Optional(Type.Boolean()),
        }),
        async execute(args) {
            return refusable("mail_set_flags", () => {
                const changes: FlagChanges = {};
                for (const flag of ["seen", "flagged", "answered"] as const) {
                    if (args[flag] !== undefined) changes[flag] = args[flag];
                }
                if (Object.keys(changes).length === 0) {
                    throw new MailToolRefusal("No flag was named: give seen, flagged or answered.");
                }
                return options.connections().use(args.account, async (imap) => {
                    await requireFolder(imap, args.folder);
                    await imap.setFlags(refsOf(args), changes);
                    return jsonResult({ changed: args.uids.length, flags: changes });
                });
            });
        },
    });

// The same call hashes to the same Message-ID, which is how a repeat finds its draft; the hash names nothing internal.
const draftMessageId = (conversationId: string, callId: string, address: string): string =>
    `<${createHash("sha256").update(`${conversationId}:${callId}`).digest("hex")}@${address.slice(address.lastIndexOf("@") + 1)}>`;

async function readAttachments(workspace: string | undefined, paths: string[]) {
    const attachments = [];
    for (const path of paths) {
        if (!isAbsolute(path) && workspace === undefined) {
            throw new Error("The conversation has no workspace to resolve a file in.");
        }
        const file = isAbsolute(path) ? path : join(workspace as string, path);
        const content = await readFile(file).catch(() => {
            throw new MailToolRefusal(`The file ${file} can't be read; no draft was saved.`);
        });
        attachments.push({ filename: basename(file), contentType: "application/octet-stream", content });
    }
    return attachments;
}

// composeMessage gives every message a Message-ID of its own; the draft's replaces it, in the header it was written to.
const withMessageId = (raw: Buffer, composedId: string, messageId: string): Buffer =>
    Buffer.from(raw.toString("latin1").replace(composedId, messageId), "latin1");

export const saveDraftTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_save_draft",
        description:
            "Save a plain-text draft in the account's Drafts folder, optionally as a reply to a message and with " +
            "files of yours attached (a relative path is relative to your workspace). Nothing is sent. Saving the " +
            "same call again saves nothing more.",
        parameters: Type.Object({
            account: accountField,
            to: Type.Array(Type.String(), { minItems: 1, description: "The recipients' addresses." }),
            subject: Type.String(),
            text: Type.String({ description: "The plain text of the message." }),
            attachments: Type.Optional(Type.Array(Type.String(), { description: "Paths of files to attach." })),
            replyTo: Type.Optional(
                Type.Object(
                    { folder: messageFields.folder, uidValidity: messageFields.uidValidity, uid: messageFields.uid },
                    { description: "The message of the same account this draft replies to." },
                ),
            ),
        }),
        async execute(args, api: ToolExecutionApi) {
            return refusable("mail_save_draft", async () => {
                const attachments = await readAttachments(api.env?.cwd, args.attachments ?? []);
                return options.connections().use(args.account, async (imap, account) => {
                    const folder = await imap.specialFolder("drafts");
                    if (folder === undefined) throw new MailToolRefusal(`The account has no Drafts folder.`);
                    const messageId = draftMessageId(String(api.conversationId), api.callId, account.address);
                    if (await imap.hasMessageId(folder, messageId)) return jsonResult({ saved: false, folder });
                    const original =
                        args.replyTo === undefined ? undefined : await readParsed(imap, refOf(args.replyTo));
                    const composed = await composeMessage({
                        from: account.address,
                        to: args.to,
                        subject: args.subject,
                        text: args.text,
                        attachments,
                        ...(original?.messageId && {
                            inReplyTo: original.messageId,
                            references: [...original.references, original.messageId],
                        }),
                    });
                    await imap.append(folder, withMessageId(composed.raw, composed.messageId, messageId), ["\\Draft"]);
                    return jsonResult({ saved: true, folder });
                });
            });
        },
    });
