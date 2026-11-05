/**
 * What a `bob` command prints (S-005 REQ-003): data to standard output, errors, notices and hints to standard error,
 * colour only when standard output is a terminal. Imports no daemon code.
 */
import type { CommandIo } from "./command_line.ts";
import { stripControl } from "./terminal_text.ts";

export type TextStyle = "bold" | "dim" | "red" | "green" | "yellow";

const STYLE_CODES: Record<TextStyle, string> = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33" };
const RESET_SEQUENCE = "\u001b[0m";
// The only sequences a terminal gets: the ones `paint` writes. They are told apart by their codes, so text that
// carries one is not told from `bob`'s own; callers print data through `terminal_text.ts` first.
const OWN_STYLE_SEQUENCES = new RegExp(`(\\u001b\\[(?:0|${Object.values(STYLE_CODES).join("|")})m)`);

// `JSON.stringify` escapes the C0 controls but writes U+0080 to U+009F raw, and a terminal may read those as the
// start of a control sequence. Inside a JSON string the escape `\u009b` is the same character, so the value is kept.
const C1_CONTROLS = /[\u0080-\u009f]/g;

const asEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * Writes the value as one JSON line, so a reader parses the output line by line: `JSON.stringify` of it, with the C1
 * control characters written as escapes so none reaches a terminal raw. The line parses to the same value.
 */
export function writeJson(io: CommandIo, value: unknown): void {
    io.stdout.write(`${JSON.stringify(value).replace(C1_CONTROLS, asEscape)}\n`);
}

/**
 * The text as a terminal may show it: no control sequence and no control character except newline and tab, so text
 * from an agent can't write the clipboard, set the title or redraw the screen. `bob`'s own colour stays on a terminal.
 */
function printable(io: CommandIo, text: string): string {
    if (!io.isStdoutTerminal) return stripControl(text);
    // The split keeps each style sequence as an odd-numbered piece.
    return text
        .split(OWN_STYLE_SEQUENCES)
        .map((piece, index) => (index % 2 === 1 ? piece : stripControl(piece)))
        .join("");
}

export function writeLine(io: CommandIo, text: string): void {
    io.stdout.write(`${printable(io, text)}\n`);
}

export function writeError(io: CommandIo, text: string): void {
    io.stderr.write(`${printable(io, text)}\n`);
}

/** Wraps the text in a colour sequence when standard output is a terminal; otherwise returns it unchanged. */
export function paint(io: CommandIo, text: string, style: TextStyle): string {
    if (!io.isStdoutTerminal) return text;
    return `\u001b[${STYLE_CODES[style]}m${text}${RESET_SEQUENCE}`;
}
