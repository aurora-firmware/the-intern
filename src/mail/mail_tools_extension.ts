/**
 * The mail tools extension (S-009 REQ-011, REQ-010): the tools an agent reads, sorts and drafts in a mail account
 * with. A tool names its account and behaves the same on an owned and a monitored one. A call that can't be answered
 * is an error result with the reason, and the agent's run goes on.
 */
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    type Extension,
    type ToolExecutionApi,
    type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
    type FlagChanges,
    type ImapConnection,
    ImapFailure,
    type MessageRef,
    type SearchQuery,
} from "./imap_client.ts";
import { composeMessage, type ParsedMessage, parseMessage } from "./mime.ts";
import { MailToolRefusal, type ToolConnections } from "./tool_connection.ts";

export const MAIL_TOOLS_EXTENSION_NAME = "intern.mail";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_FOLDER = "INBOX";

export type MailToolsOptions = {
    connections(): ToolConnections;
};

const textResult = (text: string, isError = false): ToolExecutionResult => ({
    output: [{ type: "text", text }],
    ...(isError && { isError }),
});

const jsonResult = (value: unknown): ToolExecutionResult => textResult(JSON.stringify(value, null, 2));

// A refused call, or a server that answers no, is an error result for the agent; anything else is a real failure.
async function refusable(tool: string, action: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof MailToolRefusal || error instanceof ImapFailure) {
            return textResult(`${tool} was refused: ${error.message}`, true);
        }
        throw error;
    }
}

async function requireFolder(imap: ImapConnection, folder: string): Promise<void> {
    const folders = await imap.listFolders();
    if (!folders.some((entry) => entry.path === folder)) {
        throw new MailToolRefusal(`The account has no folder "${folder}".`);
    }
}

const accountField = Type.String({ description: "The name of the mail account." });
const messageFields = {
    account: accountField,
    folder: Type.String({ description: "The folder the message is in, as mail_search returned it." }),
    uidValidity: Type.Number({ description: "The folder's UIDVALIDITY, as mail_search returned it." }),
    uid: Type.Number({ description: "The message's UID, as mail_search returned it." }),
};

const refOf = (args: { folder: string; uidValidity: number; uid: number }): MessageRef => ({
    folder: args.folder,
    uidValidity: args.uidValidity,
    uid: args.uid,
});

async function readParsed(imap: ImapConnection, ref: MessageRef): Promise<ParsedMessage> {
    await requireFolder(imap, ref.folder);
    return parseMessage(await imap.fetchMessage(ref));
}

const headersOf = (message: ParsedMessage) => ({
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
});

const listFoldersTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_list_folders",
        description: "List the folders of a mail account, with the SPECIAL-USE attribute of those that have one.",
        parameters: Type.Object({ account: accountField }),
        replay: "safe",
        async execute(args) {
            return refusable("mail_list_folders", () =>
                options
                    .connections()
                    .use(args.account, async (imap) => jsonResult({ folders: await imap.listFolders() })),
            );
        },
    });

const dayOf = (field: string, value: string | undefined): Date | undefined => {
    if (value === undefined) return undefined;
    const day = new Date(value);
    if (Number.isNaN(day.getTime())) throw new MailToolRefusal(`${field} "${value}" is not a date such as 2026-03-02.`);
    return day;
};

const searchParameters = Type.Object({
    account: accountField,
    folder: Type.Optional(Type.String({ description: `The folder to search; ${DEFAULT_FOLDER} when omitted.` })),
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    subject: Type.Optional(Type.String()),
    text: Type.Optional(Type.String({ description: "Text the message holds." })),
    since: Type.Optional(Type.String({ description: "Received on or after this day, such as 2026-03-02." })),
    before: Type.Optional(Type.String({ description: "Received before this day, such as 2026-03-02." })),
    seen: Type.Optional(Type.Boolean()),
    flagged: Type.Optional(Type.Boolean()),
    answered: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number({ description: `The most messages to return, at most ${MAX_SEARCH_LIMIT}.` })),
});

function queryOf(args: Static<typeof searchParameters>): SearchQuery {
    const query: SearchQuery = {};
    for (const field of ["from", "to", "subject", "text"] as const) {
        if (args[field] !== undefined) query[field] = args[field];
    }
    for (const field of ["seen", "flagged", "answered"] as const) {
        if (args[field] !== undefined) query[field] = args[field];
    }
    const since = dayOf("since", args.since);
    if (since !== undefined) query.since = since;
    const before = dayOf("before", args.before);
    if (before !== undefined) query.before = before;
    return query;
}

const searchTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_search",
        description:
            "Search a folder of a mail account and return the matching messages, newest first, each with the folder, " +
            "UIDVALIDITY and UID that name it, and its sender, subject and date. Name those three to read it.",
        parameters: searchParameters,
        replay: "safe",
        async execute(args) {
            return refusable("mail_search", async () => {
                const query = queryOf(args);
                const folder = args.folder ?? DEFAULT_FOLDER;
                const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
                return options.connections().use(args.account, async (imap) => {
                    await requireFolder(imap, folder);
                    const refs = await imap.search(folder, query, limit);
                    const messages = [];
                    for (const ref of refs) {
                        const message = await parseMessage(await imap.fetchMessage(ref));
                        messages.push({ ...ref, from: message.from, subject: message.subject, date: message.date });
                    }
                    return jsonResult({ messages });
                });
            });
        },
    });

const readTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_read",
        description:
            "Read one message: its headers, its text (the text of the HTML part when it has no plain part) and the list " +
            "of its attachments. Reading changes no flag.",
        parameters: Type.Object(messageFields),
        replay: "safe",
        async execute(args) {
            return refusable("mail_read", () =>
                options.connections().use(args.account, async (imap) => {
                    const message = await readParsed(imap, refOf(args));
                    return jsonResult({
                        headers: headersOf(message),
                        text: message.text,
                        attachments: message.attachments.map((attachment, index) => ({
                            index,
                            filename: attachment.filename,
                            contentType: attachment.contentType,
                            size: attachment.size,
                        })),
                    });
                }),
            );
        },
    });

// A name from a message is never trusted as a path: only its last part is used.
const fileNameOf = (filename: string | null, index: number): string => {
    const name = filename === null ? "" : basename(filename.replaceAll("\\", "/"));
    return name === "" || name === "." || name === ".." ? `attachment-${index + 1}` : name;
};

async function requireFolderOnDisk(path: string): Promise<void> {
    const found = await stat(path).catch(() => undefined);
    if (found === undefined || !found.isDirectory()) {
        throw new MailToolRefusal(`The folder ${path} does not exist.`);
    }
}

// A file this call wrote is removed again when a later one is refused, so a refused call saves nothing of the message.
async function writeAllOrNone(files: { path: string; content: Uint8Array }[]): Promise<void> {
    const written: string[] = [];
    for (const file of files) {
        try {
            await writeFile(file.path, file.content, { flag: "wx" });
            written.push(file.path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await Promise.all(written.map((path) => rm(path)));
            throw new MailToolRefusal(`The file ${file.path} exists; nothing was saved and it was left unchanged.`);
        }
    }
}

const saveAttachmentsTool = (options: MailToolsOptions) =>
    defineTool({
        name: "mail_save_attachments",
        description:
            "Save every attachment of a message, byte for byte, as a file of its own name in an existing folder. " +
            "A relative folder is relative to your workspace. A file that exists is never overwritten: the call " +
            "is refused and nothing is saved.",
        parameters: Type.Object({
            ...messageFields,
            directory: Type.String({ description: "The existing folder to save the files in." }),
        }),
        async execute(args, api: ToolExecutionApi) {
            return refusable("mail_save_attachments", async () => {
                const workspace = api.env?.cwd;
                if (workspace === undefined)
                    throw new Error("The conversation has no workspace to resolve a folder in.");
                const directory = isAbsolute(args.directory) ? args.directory : join(workspace, args.directory);
                await requireFolderOnDisk(directory);
                const message = await options.connections().use(args.account, (imap) => readParsed(imap, refOf(args)));
                const files = message.attachments.map((attachment, index) => ({
                    path: join(directory, fileNameOf(attachment.filename, index)),
                    content: attachment.content,
                }));
                await writeAllOrNone(files);
                return jsonResult({ saved: files.map((file) => file.path) });
            });
        },
    });

const uidsField = Type.Array(Type.Number(), {
    description: "The UIDs of the messages, all in the folder, as mail_search returned them.",
});

function refsOf(args: { folder: string; uidValidity: number; uids: number[] }): MessageRef[] {
    if (args.uids.length === 0) throw new MailToolRefusal("No message was named: uids is empty.");
    return args.uids.map((uid) => ({ folder: args.folder, uidValidity: args.uidValidity, uid }));
}

const moveTool = (options: MailToolsOptions) =>
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

const setFlagsTool = (options: MailToolsOptions) =>
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

const saveDraftTool = (options: MailToolsOptions) =>
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

export function createMailToolsExtension(options: MailToolsOptions): Extension {
    return defineExtension({
        name: MAIL_TOOLS_EXTENSION_NAME,
        tools: [
            listFoldersTool(options),
            searchTool(options),
            readTool(options),
            saveAttachmentsTool(options),
            moveTool(options),
            setFlagsTool(options),
            saveDraftTool(options),
        ],
    });
}
