/**
 * The mail tools extension (S-009 REQ-011, REQ-010): the tools an agent reads and saves attachments of a mail account
 * with. A tool names its account and behaves the same on an owned and a monitored one. A call that can't be answered
 * is an error result with the reason, and the agent's run goes on.
 */
import { stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    type Extension,
    type ToolExecutionApi,
    type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { type ImapConnection, ImapFailure, type MessageRef, type SearchQuery } from "./imap_client.ts";
import { type ParsedMessage, parseMessage } from "./mime.ts";
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

async function requireNoFile(path: string): Promise<void> {
    if ((await stat(path).catch(() => undefined)) !== undefined) {
        throw new MailToolRefusal(`The file ${path} exists; nothing was saved and it was left unchanged.`);
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
                for (const file of files) await requireNoFile(file.path);
                for (const file of files) await writeFile(file.path, file.content, { flag: "wx" });
                return jsonResult({ saved: files.map((file) => file.path) });
            });
        },
    });

export function createMailToolsExtension(options: MailToolsOptions): Extension {
    return defineExtension({
        name: MAIL_TOOLS_EXTENSION_NAME,
        tools: [listFoldersTool(options), searchTool(options), readTool(options), saveAttachmentsTool(options)],
    });
}
