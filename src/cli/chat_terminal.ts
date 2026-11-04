/**
 * `bob chat` on a terminal (S-005 REQ-009). It opens the front desk, prints the recent history and a prompt, submits
 * each typed line as a follow-up and prints the answers as the conversation feed brings them. Ctrl-C aborts the
 * current turn and names the lines the abort dropped; Ctrl-D leaves once every submitted line is answered. Imports the
 * client library types only, never the daemon.
 */
import { randomUUID } from "node:crypto";
import { clearLine, createInterface, cursorTo } from "node:readline";
import type { Writable } from "node:stream";
import { type Client, ClientError, UnreachableError } from "../client/client.ts";
import type { CommandIo } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { type AttributedEntryLike, createEntryTracker, followFeed } from "./feed_follower.ts";
import { conversationEntryLine } from "./feed_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";

const PROMPT = "> ";
const HISTORY_LINES = 10;
const ENTRY_PAGE_SIZE = 500;
// The most a single submissions.wait lasts (S-002 REQ-012); an unsettled submission is waited on again.
const WAIT_MS = 300_000;

export type TerminalChatOptions = { reset: boolean; json: boolean };

type EntryPage = { entries: AttributedEntryLike[]; next?: string };
type SubmitAnswer = { submissionId: string } | { held: true };
type SentLine = { submissionId: string; line: string };

/** The text of an assistant entry: its text blocks, one per line. */
export function assistantText(entry: { data?: unknown; [field: string]: unknown }): string {
    const messages = Array.isArray(entry.data) ? (entry.data as { content?: unknown }[]) : [];
    return messages
        .flatMap(({ content }) => {
            if (typeof content === "string") return [content];
            if (!Array.isArray(content)) return [];
            return content.flatMap((block: { type?: string; text?: unknown }) =>
                block.type === "text" && typeof block.text === "string" ? [block.text] : [],
            );
        })
        .join("\n");
}

/** One history entry as text: a typed line is `intern.steer` (who sent it, and the text), the rest reads as in a feed. */
function historyText(entry: AttributedEntryLike): string | undefined {
    if (entry.kind !== "intern.steer") return conversationEntryLine(entry);
    const { content } = entry.data as { content?: unknown };
    return typeof content === "string" ? `input: ${content}` : undefined;
}

async function readHistory(client: Client, conversationId: string, io: CommandIo, json: boolean) {
    const entries: AttributedEntryLike[] = [];
    let after: string | undefined;
    do {
        const page = (await client.invoke("conversations.entries", {
            conversationId,
            limit: ENTRY_PAGE_SIZE,
            ...(after !== undefined && { after }),
        })) as EntryPage;
        if (json) writeJson(io, page);
        entries.push(...page.entries);
        after = page.next;
    } while (after !== undefined);
    return entries;
}

/** A failure the follower recovers from by subscribing again: the daemon is gone, or starting or stopping. */
function isReconnectable(error: unknown): boolean {
    return error instanceof UnreachableError || (error instanceof ClientError && error.code === "unavailable");
}

async function waitUntilSettled(client: Client, submissionId: string): Promise<void> {
    for (;;) {
        const { state } = (await client.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS })) as {
            state: string;
        };
        if (state === "done" || state === "unanswered") return;
    }
}

export async function runTerminalChat(
    connect: () => Client,
    io: CommandIo,
    options: TerminalChatOptions,
): Promise<number> {
    const { json } = options;
    const client = connect();
    const desk = (await client.invoke("desk.get")) as { conversationId: string };
    const { conversationId } = desk;
    if (json) writeJson(io, desk);
    if (options.reset) await client.invoke("conversations.reset", { conversationId });

    const tracker = createEntryTracker(conversationId);
    const history = await readHistory(client, conversationId, io, json);
    for (const entry of history) tracker.markPrinted(entry.id);
    if (!json) {
        const lines = history.flatMap((entry) => historyText(entry) ?? []).flatMap((l) => l.split("\n"));
        for (const line of lines.slice(-HISTORY_LINES)) writeLine(io, line);
    }

    const lines = createInterface({
        input: io.stdin,
        output: json ? io.stderr : io.stdout,
        terminal: true,
        prompt: PROMPT,
    });
    const outcome = Promise.withResolvers<number>();
    const stop = new AbortController();
    const sent: SentLine[] = [];
    // Everything that talks to the service runs one step at a time, in the order the keys came.
    let steps: Promise<void> = Promise.resolve();
    const enqueue = (step: () => Promise<void>) => {
        steps = steps.then(step).catch(outcome.reject);
    };

    // Ctrl-D closes the interface while submitted lines are still being answered; a closed interface refuses a prompt.
    let isInputClosed = false;
    const showPrompt = (shouldKeepCursor = false) => {
        if (!isInputClosed) lines.prompt(shouldKeepCursor);
    };

    let tail: Promise<void> = Promise.resolve();
    let isCatchUpQueued = false;
    let feedClient: Client | undefined;

    async function printMissed(from: Client): Promise<void> {
        isCatchUpQueued = false;
        let missed: AttributedEntryLike[];
        try {
            missed = await tracker.catchUp(from);
        } catch (error) {
            // The daemon went away mid-read; the follower's next snapshot catches up again.
            if (isReconnectable(error)) return;
            throw error;
        }
        const answers = missed.filter((entry) => entry.kind === "pi.assistant").map(assistantText);
        if (answers.every((answer) => answer === "")) return;
        clearLine(io.stdout as Writable, 0);
        cursorTo(io.stdout as Writable, 0);
        for (const answer of answers) if (answer !== "") writeLine(io, answer);
        showPrompt(true);
    }

    function catchUp(from: Client | undefined = feedClient): Promise<void> {
        if (from === undefined || isCatchUpQueued) return tail;
        isCatchUpQueued = true;
        tail = tail.then(() => printMissed(from)).catch(outcome.reject);
        return tail;
    }

    const feed = followFeed({
        connect,
        scope: { scope: "conversation", conversationId },
        signal: stop.signal,
        onNotice: (text) => writeError(io, text),
        async onSnapshot(snapshot, from) {
            feedClient = from;
            if (json) writeJson(io, snapshot);
            else await catchUp(from);
        },
        async onDelta(delta) {
            if (json) writeJson(io, delta);
            else await catchUp();
        },
    });
    feed.catch(outcome.reject);

    async function submitLine(line: string): Promise<void> {
        const answer = (await client.invoke("conversations.submit", {
            conversationId,
            content: line,
            requestId: randomUUID(),
            busyMode: "followUp",
        })) as SubmitAnswer;
        if ("held" in answer) writeError(io, `The front desk held the line until it continues: ${line}`);
        else sent.push({ submissionId: answer.submissionId, line });
    }

    /** Stops the turn, then names each submitted line the abort left unanswered. */
    async function abortTurn(): Promise<void> {
        await client.invoke("conversations.abort", { conversationId });
        for (const entry of sent.splice(0)) {
            const { state } = (await client.invoke("submissions.get", { submissionId: entry.submissionId })) as {
                state: string;
            };
            if (state === "unanswered") writeError(io, `Dropped, not answered: ${entry.line}`);
            else if (state !== "done") sent.push(entry);
        }
        showPrompt();
    }

    async function leave(): Promise<void> {
        for (const entry of sent.splice(0)) await waitUntilSettled(client, entry.submissionId);
        if (!json) await catchUp(client);
        stop.abort();
        await feed;
        outcome.resolve(EXIT_CODES.ok);
    }

    lines.on("line", (line) => {
        if (line.trim() === "") lines.prompt();
        else enqueue(() => submitLine(line));
    });
    lines.on("SIGINT", () => enqueue(abortTurn));
    lines.on("close", () => {
        isInputClosed = true;
        enqueue(leave);
    });
    lines.prompt();
    return outcome.promise;
}
