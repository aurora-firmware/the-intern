/**
 * `bob chat` (S-005 REQ-010). Without a terminal it reads lines from standard input, submits each to the front desk
 * in turn, waits for the submission to settle and prints the answer: no prompt, no history, no colour. A daemon that
 * goes away while it runs is waited for. Imports the client library types only, never the daemon.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { type Client, createClient } from "../client/client.ts";
import { nodeTransport } from "../client/node_transport.ts";
import { assistantText, runTerminalChat } from "./chat_terminal.ts";
import type { CommandIo, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { socketPathFor, withClient } from "./connection.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import { patientClient } from "./patient_client.ts";

// The most a single submissions.wait lasts (S-002 REQ-012); an unsettled submission is waited on again.
const WAIT_MS = 300_000;
const ENTRY_PAGE_SIZE = 500;

type Entry = { kind: string; data: unknown };
type EntryPage = { entries: Entry[]; next?: string };
type SubmitAnswer = { submissionId: string } | { held: true };

/** Where the entries read before a submission end: the cursor of their last page and how many that page holds. */
type EntriesMark = { after?: string; skip: number };

async function markEnd(client: Client, conversationId: string): Promise<EntriesMark> {
    let mark: EntriesMark = { skip: 0 };
    let after: string | undefined;
    do {
        const page = (await client.invoke("conversations.entries", {
            conversationId,
            limit: ENTRY_PAGE_SIZE,
            ...(after !== undefined && { after }),
        })) as EntryPage;
        mark = { ...(after !== undefined && { after }), skip: page.entries.length };
        after = page.next;
    } while (after !== undefined);
    return mark;
}

/** Reads the pages from the mark on; each is passed to `onPage` as the service gave it. */
async function readSince(
    client: Client,
    conversationId: string,
    mark: EntriesMark,
    onPage: (page: EntryPage) => void,
): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after = mark.after;
    do {
        const page = (await client.invoke("conversations.entries", {
            conversationId,
            limit: ENTRY_PAGE_SIZE,
            ...(after !== undefined && { after }),
        })) as EntryPage;
        onPage(page);
        entries.push(...page.entries);
        after = page.next;
    } while (after !== undefined);
    return entries.slice(mark.skip);
}

async function waitUntilSettled(client: Client, submissionId: string): Promise<void> {
    for (;;) {
        const { state } = (await client.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as {
            state: string;
        };
        if (state === "done" || state === "unanswered") return;
    }
}

/** Submits one line to the front desk and prints its answer; returns false when the service held the line. */
async function exchange(client: Client, io: CommandIo, conversationId: string, line: string, json: boolean) {
    const mark = await markEnd(client, conversationId);
    const answer = (await client.invoke("conversations.submit", {
        conversationId,
        content: line,
        requestId: randomUUID(),
        busyMode: "followUp",
    })) as SubmitAnswer;
    if ("held" in answer) {
        writeError(io, `The front desk held the line until it continues: ${line}`);
        return false;
    }
    await waitUntilSettled(client, answer.submissionId);
    const entries = await readSince(client, conversationId, mark, (page) => {
        if (json) writeJson(io, page);
    });
    if (json) return true;
    for (const entry of entries.filter(({ kind }) => kind === "pi.assistant")) writeLine(io, assistantText(entry));
    return true;
}

export async function runPipedChat(client: Client, io: CommandIo, json: boolean, reset = false): Promise<number> {
    // A daemon that is absent at the start ends the command (S-005 AC-002.2); one lost later is waited for (REQ-015).
    const { conversationId } = (await client.invoke("desk.get")) as { conversationId: string };
    if (reset) await client.invoke("conversations.reset", { conversationId });
    const patient = patientClient(client, { onNotice: (text) => writeError(io, text) });
    const lines = createInterface({ input: io.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
        if (line.trim() === "") continue;
        if (!(await exchange(patient, io, conversationId, line, json))) return EXIT_CODES.refused;
    }
    return EXIT_CODES.ok;
}

export const chatCommand: CommandSpec = {
    verb: "chat",
    summary: "Talk to the front desk.",
    positionals: [],
    options: { reset: { type: "boolean", description: "Empty the front desk's next context before chatting." } },
    isData: true,
    callsService: true,
    run: (input) => {
        const reset = input.options.reset === true;
        // A terminal is standard input and output together (S-005 Definitions); redirected output takes the piped path.
        if (input.io.isStdinTerminal && input.io.isStdoutTerminal) {
            const connect = () => createClient(nodeTransport({ socketPath: socketPathFor(input) }));
            return withClient(input, () => runTerminalChat(connect, input.io, { reset, json: input.json }));
        }
        return withClient(input, (client) => runPipedChat(client, input.io, input.json, reset));
    },
};
