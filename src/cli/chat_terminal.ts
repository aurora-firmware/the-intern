/**
 * `bob chat` on a terminal (S-005 REQ-009). It opens the front desk, prints the recent history and a prompt, submits
 * each typed line as a follow-up and prints the answers as the conversation feed brings them, an answer still being
 * written as it grows (chat_screen.ts). A daemon that goes away is waited for, with typed lines kept. Ctrl-C aborts the
 * current turn and names the lines the abort dropped, also while Ctrl-D waits; Ctrl-D leaves once every submitted line
 * is answered, or says which are not when the daemon goes away. Imports the client library types only, never the
 * daemon.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import type { Client } from "../client/client.ts";
import { assistantText, createChatScreen, partialAnswer, responseTimestamps } from "./chat_screen.ts";
import type { CommandIo } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { type AttributedEntryLike, createEntryTracker, followFeed, outageNoticeFor } from "./feed_follower.ts";
import { conversationEntryLine } from "./feed_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import { patientClient } from "./patient_client.ts";
import { flat } from "./terminal_text.ts";

const PROMPT = "> ";
const HISTORY_LINES = 10;
const ENTRY_PAGE_SIZE = 500;
// The most a single submissions.wait lasts (S-002 REQ-012); an unsettled submission is waited on again.
const WAIT_MS = 300_000;

export type TerminalChatOptions = { reset: boolean; json: boolean };

type EntryPage = { entries: AttributedEntryLike[]; next?: string };
type SubmitAnswer = { submissionId: string } | { held: true };
type SentLine = { submissionId: string; line: string };
/** A typed line; its request id is fixed when it is typed, so every attempt to submit it is the same submission. */
type TypedLine = { line: string; requestId: string };

/** One history entry as text: a typed line is `intern.steer` (who sent it, and the text), the rest reads as in a feed. */
function historyText(entry: AttributedEntryLike): string | undefined {
    if (entry.kind !== "intern.steer") return conversationEntryLine(entry);
    const { content } = entry.data as { content?: unknown };
    return typeof content === "string" ? `input: ${flat(content)}` : undefined;
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
    return outageNoticeFor(error) !== undefined;
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
    // A daemon that is absent at the start ends the command (S-005 AC-002.2); one that is starting or stopping, or lost
    // later, is waited for (REQ-015).
    const starting = patientClient(client, { onNotice: (text) => writeError(io, text), isAbsentFatalAtStart: true });
    const desk = (await starting.invoke("desk.get")) as { conversationId: string };
    const { conversationId } = desk;
    if (json) writeJson(io, desk);
    if (options.reset) await starting.invoke("conversations.reset", { conversationId });

    const tracker = createEntryTracker(conversationId);
    const history = await readHistory(starting, conversationId, io, json);
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
    // Aborted by Ctrl-D: from then on a call that meets an outage gives up, so a gone daemon doesn't trap the team member.
    const leaving = new AbortController();
    const sent: SentLine[] = [];
    // Lines typed and not yet admitted by the service, in the order they were typed.
    const unadmitted: TypedLine[] = [];
    // One notice per outage, whether the feed or a call meets it first.
    let lastNotice: string | undefined;
    // Ctrl-D closes the interface while submitted lines are still being answered; a closed interface refuses a prompt.
    let isInputClosed = false;
    const screen = createChatScreen({
        output: (json ? io.stderr : io.stdout) as Writable & { columns?: number },
        lines,
        prompt: PROMPT,
        isOpen: () => !isInputClosed,
    });
    // The line editor takes Enter after this listener, so the screen can take the answer's tail off the prompt first.
    io.stdin.prependListener("keypress", (_character: unknown, key?: { name?: string }) => {
        if (key?.name === "return" || key?.name === "enter") screen.beforeSubmit();
    });
    // A notice or a message of the command's own goes on a line of its own, not in the middle of an answer or a typed line.
    const warn = (text: string) => screen.notice(() => writeError(io, text));
    const notify = (text: string) => {
        if (text === lastNotice) return;
        lastNotice = text;
        warn(text);
    };
    const patient = patientClient(client, {
        onNotice: notify,
        onRecovered: () => {
            lastNotice = undefined;
        },
        signal: leaving.signal,
    });
    // Everything that talks to the service runs one step at a time, in the order the keys came.
    let steps: Promise<void> = Promise.resolve();
    const enqueue = (step: () => Promise<void>) => {
        steps = steps.then(step).catch(outcome.reject);
    };

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
        const answers = missed.filter((entry) => entry.kind === "pi.assistant");
        if (answers.every((entry) => assistantText(entry) === "")) return;
        for (const entry of answers) screen.showAnswer(assistantText(entry), responseTimestamps(entry));
    }

    /** Shows the response in flight, in order with the answers printed from the entries. */
    function showLive(live: unknown): Promise<void> {
        const partial = partialAnswer(live);
        if (partial === undefined) return tail;
        tail = tail.then(() => screen.showPartial(partial.text, partial.timestamp)).catch(outcome.reject);
        return tail;
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
        onNotice: notify,
        async onSnapshot(snapshot, from) {
            lastNotice = undefined;
            feedClient = from;
            if (json) {
                writeJson(io, snapshot);
                return;
            }
            await catchUp(from);
            await showLive((snapshot as { live?: unknown }).live);
        },
        async onDelta(delta) {
            if (json) {
                writeJson(io, delta);
                return;
            }
            await showLive((delta as { view?: { live?: unknown } }).view?.live);
            await catchUp();
        },
    });
    feed.catch(outcome.reject);

    /** Submits the line, waiting out an outage; after Ctrl-D it tries once more and then leaves the line unadmitted. */
    async function submitLine(typed: TypedLine): Promise<void> {
        let answer: SubmitAnswer;
        try {
            answer = (await patient.invoke("conversations.submit", {
                conversationId,
                content: typed.line,
                requestId: typed.requestId,
                busyMode: "followUp",
            })) as SubmitAnswer;
        } catch (error) {
            if (isReconnectable(error)) return;
            throw error;
        }
        unadmitted.splice(unadmitted.indexOf(typed), 1);
        if ("held" in answer) warn(`The front desk held the line until it continues: ${typed.line}`);
        else sent.push({ submissionId: answer.submissionId, line: typed.line });
    }

    /** Stops the turn, then names each submitted line the abort left unanswered. */
    async function abortTurn(): Promise<void> {
        try {
            await patient.invoke("conversations.abort", { conversationId });
            for (const entry of [...sent]) {
                const { state } = (await patient.invoke("submissions.get", { submissionId: entry.submissionId })) as {
                    state: string;
                };
                if (state === "unanswered") warn(`Dropped, not answered: ${entry.line}`);
                if (state === "unanswered" || state === "done") sent.splice(sent.indexOf(entry), 1);
            }
        } catch (error) {
            if (!isReconnectable(error)) throw error;
            // Only Ctrl-D makes a call give up on an outage; the abort that was asked for isn't done.
            warn("The Intern went away before the turn was stopped; it may still be running");
            return;
        }
        showPrompt();
    }

    /** Names each submitted line that has no answer because the daemon went away while Ctrl-D waited for it. */
    function reportLostAnswers(settled: ReadonlySet<string>): void {
        for (const { submissionId, line } of sent.splice(0)) {
            if (!settled.has(submissionId)) warn(`The Intern went away; not answered: ${line}`);
        }
    }

    /** Waits for the answers to the submitted lines; a daemon that goes away after Ctrl-D ends the wait, said so. */
    async function waitForAnswers(): Promise<void> {
        const settled = new Set<string>();
        try {
            for (const { submissionId } of [...sent]) {
                await waitUntilSettled(patient, submissionId);
                settled.add(submissionId);
            }
        } catch (error) {
            if (!isReconnectable(error)) throw error;
            reportLostAnswers(settled);
        }
    }

    // Once Ctrl-D has closed the interface it no longer reads Ctrl-C, so the signal reaches the process: it stops the turn.
    // The wait ends as soon as the abort drops the lines, so the abort is waited for before leaving: it is still naming
    // them.
    let interruption: Promise<void> = Promise.resolve();
    const interruptWait = () => {
        interruption = interruption.then(abortTurn).catch(outcome.reject);
    };

    async function leave(): Promise<void> {
        process.on("SIGINT", interruptWait);
        try {
            await waitForAnswers();
        } finally {
            process.off("SIGINT", interruptWait);
        }
        await interruption;
        if (!json) await catchUp(client);
        stop.abort();
        await feed;
        screen.settle();
        for (const { line } of unadmitted) warn(`Not sent, the front desk was unreachable: ${line}`);
        outcome.resolve(EXIT_CODES.ok);
    }

    lines.on("line", (line) => {
        if (line.trim() !== "") {
            const typed = { line, requestId: randomUUID() };
            unadmitted.push(typed);
            enqueue(() => submitLine(typed));
        }
        screen.afterSubmit();
    });
    lines.on("SIGINT", () => enqueue(abortTurn));
    lines.on("close", () => {
        isInputClosed = true;
        screen.closed();
        leaving.abort();
        enqueue(leave);
    });
    lines.prompt();
    return outcome.promise;
}
