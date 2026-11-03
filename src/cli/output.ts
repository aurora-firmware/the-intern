/**
 * What a `bob` command prints (S-005 REQ-003): data to standard output, errors, notices and hints to standard error,
 * colour only when standard output is a terminal. Imports no daemon code.
 */
import type { CommandIo } from "./command_line.ts";

export type TextStyle = "bold" | "dim" | "red" | "green" | "yellow";

const STYLE_CODES: Record<TextStyle, string> = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33" };
const RESET_SEQUENCE = "\u001b[0m";

/** Writes the value as one JSON line, exactly `JSON.stringify` of it, so a reader parses the output line by line. */
export function writeJson(io: CommandIo, value: unknown): void {
    io.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeLine(io: CommandIo, text: string): void {
    io.stdout.write(`${text}\n`);
}

export function writeError(io: CommandIo, text: string): void {
    io.stderr.write(`${text}\n`);
}

/** Wraps the text in a colour sequence when standard output is a terminal; otherwise returns it unchanged. */
export function paint(io: CommandIo, text: string, style: TextStyle): string {
    if (!io.isStdoutTerminal) return text;
    return `\u001b[${STYLE_CODES[style]}m${text}${RESET_SEQUENCE}`;
}
