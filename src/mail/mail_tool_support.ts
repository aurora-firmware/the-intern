/**
 * What the mail tools share (S-009 REQ-011): their options, their results, how a refused call becomes an error
 * result, and the fields that name an account and a message.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { HarnessHost } from "../host/harness_host.ts";
import { type ImapConnection, ImapFailure, type MessageRef } from "./imap_client.ts";
import { type ParsedMessage, parseMessage } from "./mime.ts";
import type { Outbox } from "./outbox.ts";
import { MailToolRefusal, type ToolConnections } from "./tool_connection.ts";

export type MailToolsOptions = {
    connections(): ToolConnections;
    /** The host, or undefined until the daemon has opened it. */
    host(): HarnessHost | undefined;
    /** The started outbox, or undefined before the mail component starts. */
    outbox(): Outbox | undefined;
};

export const textResult = (text: string, isError = false): ToolExecutionResult => ({
    output: [{ type: "text", text }],
    ...(isError && { isError }),
});

export const jsonResult = (value: unknown): ToolExecutionResult => textResult(JSON.stringify(value, null, 2));

// A refused call, or a server that answers no, is an error result for the agent; anything else is a real failure.
export async function refusable(
    tool: string,
    action: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof MailToolRefusal || error instanceof ImapFailure) {
            return textResult(`${tool} was refused: ${error.message}`, true);
        }
        throw error;
    }
}

export async function requireFolder(imap: ImapConnection, folder: string): Promise<void> {
    const folders = await imap.listFolders();
    if (!folders.some((entry) => entry.path === folder)) {
        throw new MailToolRefusal(`The account has no folder "${folder}".`);
    }
}

export const accountField = Type.String({ description: "The name of the mail account." });
export const messageFields = {
    account: accountField,
    folder: Type.String({ description: "The folder the message is in, as mail_search returned it." }),
    uidValidity: Type.Number({ description: "The folder's UIDVALIDITY, as mail_search returned it." }),
    uid: Type.Number({ description: "The message's UID, as mail_search returned it." }),
};

export const refOf = (args: { folder: string; uidValidity: number; uid: number }): MessageRef => ({
    folder: args.folder,
    uidValidity: args.uidValidity,
    uid: args.uid,
});

export async function readParsed(imap: ImapConnection, ref: MessageRef): Promise<ParsedMessage> {
    await requireFolder(imap, ref.folder);
    return parseMessage(await imap.fetchMessage(ref));
}
