/**
 * What `bob chat` puts on a terminal of the front desk's answers (S-005 REQ-009). An answer is written as it grows: the
 * committed partial of the response in flight (`pi.live`, S-002 REQ-014) is printed as it comes. Its finished rows are
 * written above the prompt for good, cut at the screen width on a space, so no row of it is ever drawn again. What is
 * left of the last row, less than one screen row wide, is the tail: a row of its own between the answer and the prompt,
 * written again as it grows. The prompt, with the line the team member is typing, stays below it all and belongs to the
 * line editor: the screen climbs to the top of the prompt, clears from there, writes, and asks the line editor to draw
 * the prompt again where it was (`prompt(true)`), so the editor's history and cursor are never touched. The stored
 * entry that follows only completes the tail. Only the text blocks of a message are shown, as in the entries. A partial
 * that no longer continues the printed text (a response started again after a restart) starts a new row, and a partial
 * of a response whose entry is already printed is dropped. Imports no daemon code.
 */
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import type { Writable } from "node:stream";
import { block } from "./terminal_text.ts";
import { cutRows, displayRow } from "./text_rows.ts";

type MessageLike = { content?: unknown; timestamp?: unknown };

export type ChatScreen = {
    /** Shows the text of the response in flight so far; `timestamp` tells which response it is. */
    showPartial(text: string, timestamp: number | undefined): void;
    /** Shows a stored answer: completes the tail when the answer continues it, else prints it on rows. */
    showAnswer(text: string, timestamps: number[]): void;
    /** Ends the tail as a row, so the exit starts on a line of its own; a later entry still finds what was shown. */
    settle(): void;
    /** Runs the write (a notice) on a line of its own above the prompt, the tail of the answer ended first. */
    notice(write: () => void): void;
    /** To call just before the line editor takes Enter: the tail leaves the screen, so it isn't left above the line. */
    beforeSubmit(): void;
    /** To call once a line was entered: the tail comes back below it, with the prompt. */
    afterSubmit(): void;
    /** To call once the line editor is closed (Ctrl-D): the prompt and the tail leave the screen; the tail shows when it completes. */
    closed(): void;
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

/** What the screen needs of the line editor: where its cursor is in the prompt, and the prompt drawn again. */
export type PromptLine = {
    readonly line: string;
    /** How many rows the next drawing of the prompt climbs from the cursor; readline keeps it, undocumented. */
    readonly prevRows?: number;
    getCursorPos(): { rows: number; cols: number };
    prompt(shouldKeepCursor?: boolean): void;
};

export type ChatScreenOptions = {
    /** Where the line editor draws; the answers go there too. */
    output: Writable & { columns?: number };
    lines: PromptLine;
    prompt: string;
    /** False once the line editor is closed (Ctrl-D): it can no longer draw a prompt. */
    isOpen(): boolean;
};

const DEFAULT_COLUMNS = 80;

export function createChatScreen(options: ChatScreenOptions): ChatScreen {
    const { output, lines, prompt: PROMPT, isOpen } = options;
    // The text of the response in flight that was shown, and how much of it is in the scrollback: whole rows, written
    // for good. What is left is the tail, one screen row at most, shown as a row of its own above the prompt.
    let shown = "";
    let committed = 0;
    let isTailShown = false;
    const answeredAt = new Set<number>();

    const tail = () => shown.slice(committed);
    // A row one cell short of the width, so a full row never leaves the cursor waiting to wrap. A terminal that tells
    // no width (none, or 0) is taken to be as wide as the usual one.
    const rowWidth = () => (output.columns || DEFAULT_COLUMNS) - 1;

    /** The rows of the text from `from` on, each ended; the last one only when `isFinal`, else it is the tail. */
    function layout(text: string, from: number, isFinal: boolean): { rows: string; end: number } {
        const rows: string[] = [];
        let at = from;
        for (;;) {
            const newline = text.indexOf("\n", at);
            const line = text.slice(at, newline === -1 ? undefined : newline);
            const cut = cutRows(line, rowWidth());
            rows.push(...cut.rows);
            const rest = line.slice(cut.consumed);
            const isRowLeft = rest !== "" || (cut.rows.length === 0 && newline !== -1);
            if (newline !== -1) {
                if (isRowLeft) rows.push(displayRow(rest));
                at = newline + 1;
                continue;
            }
            if (isFinal && rest !== "") rows.push(displayRow(rest));
            const end = isFinal ? text.length : at + cut.consumed;
            return { rows: rows.map((row) => `${row}\n`).join(""), end };
        }
    }

    /**
     * Writes above the prompt, then the tail, then draws the prompt again. The line editor knows how many screen lines
     * its prompt and typed line fill, and where its cursor is in them; this climbs to the top of them (and of the tail
     * row, if one is shown), clears down, writes, and leaves the cursor as far down as it was for the editor to start
     * from, which it does by drawing the prompt with the cursor kept.
     */
    function redraw(writeAbove: () => void, withTail = true): void {
        if (!isOpen()) {
            writeAbove();
            return;
        }
        const { rows: above } = lines.getCursorPos();
        moveCursor(output, 0, -(above + (isTailShown ? 1 : 0)));
        cursorTo(output, 0);
        clearScreenDown(output);
        writeAbove();
        isTailShown = withTail && tail() !== "";
        if (isTailShown) output.write(`${displayRow(tail())}\n`);
        // The editor climbs its own count of rows, which is behind the cursor's row after a chunk of typed text that
        // wrapped; the cursor starts that many rows down, so the drawing begins at the top of the prompt.
        output.write("\n".repeat(lines.prevRows ?? above));
        lines.prompt(true);
    }

    /** Ends the tail as a row of its own; what comes next starts a new row. */
    function commitTail(): string {
        const pending = tail();
        committed = shown.length;
        return pending === "" ? "" : `${displayRow(pending)}\n`;
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
            if (isOpen() && isTailShown) redraw(() => {}, false);
        },
        afterSubmit() {
            if (!isOpen()) return;
            isTailShown = tail() !== "";
            if (isTailShown) output.write(`${displayRow(tail())}\n`);
            lines.prompt();
        },
        closed() {
            const { rows: above } = lines.getCursorPos();
            moveCursor(output, 0, -(above + (isTailShown ? 1 : 0)));
            cursorTo(output, 0);
            clearScreenDown(output);
            isTailShown = false;
            if (lines.line !== "") output.write(`${PROMPT}${lines.line}\n`);
        },
        showPartial(text, timestamp) {
            if (timestamp !== undefined && answeredAt.has(timestamp)) return;
            if (shown.startsWith(text)) return;
            const restarted = text.startsWith(shown) ? "" : restart();
            const { rows, end } = layout(text, committed, false);
            shown = text;
            committed = end;
            redraw(() => output.write(restarted + rows));
        },
        showAnswer(text, timestamps) {
            for (const timestamp of timestamps) answeredAt.add(timestamp);
            if (text === "") return;
            let rows = "";
            if (shown.startsWith(text)) rows = commitTail();
            else {
                if (!text.startsWith(shown)) rows = restart();
                rows += layout(text, committed, true).rows;
            }
            shown = "";
            committed = 0;
            redraw(() => output.write(rows));
        },
    };
}
