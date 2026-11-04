/**
 * Data on a terminal (S-005 AC-003.4). Text an agent or a team member wrote is printed through these functions, so it
 * never reaches the screen as a control sequence, and a line of a single-line format never takes a line break from
 * data. The stored text is not changed. Imports nothing.
 */

const ESC = "\u001b";
const BEL = "\u0007";

// Control sequences, string sequences (operating system command, device control and the like) and any other escape,
// including one cut off at the end of a text that is still growing.
const ESCAPE_SEQUENCES = new RegExp(
    [
        `${ESC}\\[[0-?]*[ -/]*[@-~]`,
        `${ESC}\\[[0-?]*[ -/]*$`,
        `${ESC}[\\]PX^_][^${BEL}${ESC}\\n]*(?:${BEL}|${ESC}\\\\)?`,
        `${ESC}[ -/]*[0-~]?`,
    ].join("|"),
    "g",
);
// The C0 controls except tab and newline, delete, the C1 controls, and the characters that reorder text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is what this does
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
const CONTINUATION_INDENT = "    ";

/** The text without any control sequence or control character; newlines and tabs stay. */
export function stripControl(text: string): string {
    return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROL_CHARACTERS, "");
}

/** The text on one line: control sequences removed, every run of white space, line breaks included, one space. */
export function flat(text: string): string {
    return stripControl(text).replace(/\s+/g, " ").trim();
}

/** The text with its lines kept and no control sequence. */
export function block(text: string): string {
    return stripControl(text.replace(LINE_SEPARATORS, "\n"));
}

/**
 * Multi-line data inside a line of output: its lines kept, each after the first indented, so no line of data starts at
 * the margin where a status line starts.
 */
export function continued(text: string): string {
    return block(text).trimEnd().split("\n").join(`\n${CONTINUATION_INDENT}`);
}
