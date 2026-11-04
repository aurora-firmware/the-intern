/**
 * What `bob chat` puts on a terminal of the front desk's answers (S-005 REQ-009). An answer is written as it grows: the
 * committed partial of the response in flight (`pi.live`, S-002 REQ-014) is printed as it comes, its finished lines
 * above the prompt and the line still being written as the head of the prompt, and the stored entry that follows only
 * completes that line. The line the team member is typing is always below the answer, and the line editor, which
 * redraws the prompt, redraws the answer's last line with it, so typing, erasing or Enter never cuts the answer. Only
 * the text blocks of a message are shown, as in the entries. A partial that no longer continues the printed text (a
 * response started again after a restart) starts a new line, and a partial of a response whose entry is already
 * printed is dropped. Imports no daemon code.
 */
import { clearLine, cursorTo } from "node:readline";
import type { Writable } from "node:stream";
import { block } from "./terminal_text.ts";

type MessageLike = { content?: unknown; timestamp?: unknown };

export type ChatScreen = {
    /** Shows the text of the response in flight so far; `timestamp` tells which response it is. */
    showPartial(text: string, timestamp: number | undefined): void;
    /** Shows a stored answer: completes the open line when the answer continues it, else prints it on a line. */
    showAnswer(text: string, timestamps: number[]): void;
    /** Ends the tail as a line, so the exit starts on a line of its own; a later entry still finds what was shown. */
    settle(): void;
    /** Runs the write (a notice) on a line of its own above the prompt, the tail of the answer ended first. */
    notice(write: () => void): void;
    /** To call just before the line editor takes Enter: the tail leaves the prompt, so it isn't left behind the line. */
    beforeSubmit(): void;
    /** To call once a line was entered: the prompt comes back below it, with the tail. */
    afterSubmit(): void;
};

function textBlocks(message: MessageLike): string[] {
    const { content } = message;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block: { type?: string; text?: unknown }) =>
        block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    );
}

/** The text of an assistant entry: its text blocks, one per line, without control sequences. */
export function assistantText(entry: { data?: unknown; [field: string]: unknown }): string {
    const messages = Array.isArray(entry.data) ? (entry.data as MessageLike[]) : [];
    return block(messages.flatMap(textBlocks).join("\n"));
}

/** The ids of the responses an assistant entry holds: the timestamps of its messages. */
export function responseTimestamps(entry: { data?: unknown; [field: string]: unknown }): number[] {
    const messages = Array.isArray(entry.data) ? (entry.data as MessageLike[]) : [];
    return messages.flatMap(({ timestamp }) => (typeof timestamp === "number" ? [timestamp] : []));
}

/** The response in flight in a conversation's live view, if it has written any text yet. */
export function partialAnswer(live: unknown): { text: string; timestamp: number | undefined } | undefined {
    const message = (live as { generation?: { message?: MessageLike } } | null | undefined)?.generation?.message;
    if (message === undefined) return undefined;
    const text = block(textBlocks(message).join("\n"));
    if (text === "") return undefined;
    return { text, timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined };
}

/** What the screen needs of the line editor: the typed line, the prompt it draws, and keys it can be sent. */
export type PromptLine = {
    readonly line: string;
    readonly cursor: number;
    setPrompt(prompt: string): void;
    prompt(shouldKeepCursor?: boolean): void;
    write(data: string | null, key?: { ctrl?: boolean; name?: string }): void;
};

export type ChatScreenOptions = {
    /** Where the line editor draws; the answers go there too. */
    output: Writable;
    lines: PromptLine;
    prompt: string;
    /** False once the line editor is closed (Ctrl-D): it can no longer draw a prompt. */
    isOpen(): boolean;
};

const GO_TO_END = { ctrl: true, name: "e" };
const DELETE_TO_START = { ctrl: true, name: "u" };
const ONE_LEFT = { name: "left" };
const TAB_AS_SPACES = "    ";

export function createChatScreen(options: ChatScreenOptions): ChatScreen {
    const { output, lines, prompt: PROMPT, isOpen } = options;
    // The text of the response in flight that was shown, and how much of it is in the scrollback: whole lines, written
    // above the prompt for good. What is left of the last line is the tail, which is part of the prompt, so the line
    // editor redraws it with the rest and the typed line never shares a screen line with the answer.
    let shown = "";
    let committed = 0;
    const answeredAt = new Set<number>();

    const tail = () => shown.slice(committed);

    function promptWithTail(): string {
        const pending = tail();
        return pending === "" ? PROMPT : `${pending.replaceAll("\t", TAB_AS_SPACES)}\n${PROMPT}`;
    }

    /**
     * Writes above the prompt, then draws the prompt again with the typed line and the tail. Erasing goes through the
     * line editor, which knows how many screen lines its prompt and typed line fill.
     */
    function redraw(writeAbove: () => void): void {
        if (!isOpen()) {
            writeAbove();
            return;
        }
        const { line, cursor } = lines;
        lines.setPrompt(PROMPT);
        lines.write(null, GO_TO_END);
        lines.write(null, DELETE_TO_START);
        cursorTo(output, 0);
        clearLine(output, 0);
        writeAbove();
        lines.setPrompt(promptWithTail());
        lines.prompt();
        if (line === "") return;
        lines.write(line);
        for (let behind = line.length - cursor; behind > 0; behind--) lines.write(null, ONE_LEFT);
    }

    /** Ends the tail as a line of its own; what comes next starts a new line. */
    function commitTail(): string {
        const pending = tail();
        committed = shown.length;
        return pending === "" ? "" : `${pending}\n`;
    }

    function restart(): string {
        const rows = commitTail();
        shown = "";
        committed = 0;
        return rows;
    }

    function notice(write: () => void): void {
        const rows = commitTail();
        redraw(() => {
            output.write(rows);
            write();
        });
    }

    return {
        notice,
        settle: () => notice(() => {}),
        beforeSubmit() {
            if (!isOpen() || tail() === "") return;
            lines.setPrompt(PROMPT);
            lines.prompt(true);
        },
        afterSubmit() {
            if (!isOpen()) return;
            lines.setPrompt(promptWithTail());
            lines.prompt();
        },
        showPartial(text, timestamp) {
            if (timestamp !== undefined && answeredAt.has(timestamp)) return;
            if (shown.startsWith(text)) return;
            const rows = text.startsWith(shown) ? "" : restart();
            const completeLines = text.slice(0, text.lastIndexOf("\n") + 1);
            const newRows = completeLines.length > committed ? completeLines.slice(committed) : "";
            shown = text;
            committed = Math.max(committed, completeLines.length);
            redraw(() => output.write(rows + newRows));
        },
        showAnswer(text, timestamps) {
            for (const timestamp of timestamps) answeredAt.add(timestamp);
            if (text === "") return;
            let rows = "";
            if (shown.startsWith(text)) rows = commitTail();
            else {
                if (!text.startsWith(shown)) rows = restart();
                rows += `${text.slice(committed)}\n`;
            }
            shown = "";
            committed = 0;
            redraw(() => output.write(rows));
        },
    };
}
