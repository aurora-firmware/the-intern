/**
 * What `bob chat` puts on a terminal of the front desk's answers (S-005 REQ-009). An answer is written as it grows: the
 * committed partial of the response in flight (`pi.live`, S-002 REQ-014) is printed piece by piece on one open line,
 * and the stored entry that follows only completes that line. Only the text blocks of a message are shown, as in the
 * entries. A partial that no longer continues the printed text (a response started again after a restart) starts a new
 * line, and a partial of a response whose entry is already printed is dropped. Imports no daemon code.
 */
import { clearLine, cursorTo } from "node:readline";
import type { Writable } from "node:stream";
import type { CommandIo } from "./command_line.ts";
import { block } from "./terminal_text.ts";

type MessageLike = { content?: unknown; timestamp?: unknown };

export type ChatScreen = {
    /** Shows the text of the response in flight so far; `timestamp` tells which response it is. */
    showPartial(text: string, timestamp: number | undefined): void;
    /** Shows a stored answer: completes the open line when the answer continues it, else prints it on a line. */
    showAnswer(text: string, timestamps: number[]): void;
    /** Ends an open line, so a notice or the exit starts on a line of its own; a later entry still finds what was shown. */
    settle(): void;
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

export function createChatScreen(io: CommandIo): ChatScreen {
    const output = io.stdout as Writable;
    // The text of the response in flight that is on the screen, and whether the cursor is still at the end of it.
    let shown = "";
    let isLineOpen = false;
    const answeredAt = new Set<number>();

    function write(text: string): void {
        if (!isLineOpen) {
            // The prompt is on the cursor's line; the answer takes its place and the next prompt is drawn below it.
            clearLine(output, 0);
            cursorTo(output, 0);
        }
        output.write(text);
        isLineOpen = true;
    }

    function closeLine(): void {
        if (isLineOpen) output.write("\n");
        isLineOpen = false;
    }

    // A notice may end the line a response is on before its entry lands, so what was shown is kept until then.
    return {
        settle: closeLine,
        showPartial(text, timestamp) {
            if (timestamp !== undefined && answeredAt.has(timestamp)) return;
            if (shown.startsWith(text)) return;
            if (!text.startsWith(shown)) {
                closeLine();
                shown = "";
            }
            write(text.slice(shown.length));
            shown = text;
        },
        showAnswer(text, timestamps) {
            for (const timestamp of timestamps) answeredAt.add(timestamp);
            if (text === "") return;
            if (!shown.startsWith(text)) {
                if (!text.startsWith(shown)) {
                    closeLine();
                    shown = "";
                }
                write(text.slice(shown.length));
            }
            closeLine();
            shown = "";
        },
    };
}
