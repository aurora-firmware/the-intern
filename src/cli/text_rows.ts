/**
 * Cuts text into rows that fit a number of terminal cells, so a screen knows how many rows text fills without asking the
 * terminal. A cell count is an estimate: a combining mark takes none, and an emoji or an East Asian wide character two.
 * Imports nothing.
 */

const TAB_CELLS = 4;
const TAB_AS_SPACES = " ".repeat(TAB_CELLS);
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;
const WIDE_RANGES: readonly (readonly [number, number])[] = [
    [0x1100, 0x115f],
    [0x2e80, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd],
];

/** The cells one character takes on a terminal. */
export function cellsOf(char: string): number {
    if (char === "\t") return TAB_CELLS;
    if (ZERO_WIDTH.test(char)) return 0;
    const code = char.codePointAt(0) as number;
    const isWide = EMOJI.test(char) || WIDE_RANGES.some(([from, to]) => code >= from && code <= to);
    return isWide ? 2 : 1;
}

/** The text as a row shows it: tabs as spaces, so what is printed takes the cells that were counted. */
export function displayRow(text: string): string {
    return text.replaceAll("\t", TAB_AS_SPACES);
}

/** Where the row that starts at `start` runs out of cells: the index of the first character that doesn't fit. */
function overflowIndex(line: string, start: number, width: number): number {
    let used = 0;
    let index = start;
    for (const char of line.slice(start)) {
        used += cellsOf(char);
        if (used > width) return index;
        index += char.length;
    }
    return line.length;
}

/** Where to cut the row that overflows at `overflow`: after the last space that fits, else in the middle of a word. */
function breakAt(line: string, start: number, overflow: number): { end: number; next: number } {
    if (line[overflow] === " ") return { end: overflow, next: overflow + 1 };
    const space = line.lastIndexOf(" ", overflow - 1);
    return space > start ? { end: space, next: space + 1 } : { end: overflow, next: overflow };
}

/**
 * Cuts rows off the front of a line (no line break in it) while what is left is wider than `width` cells. A row ends
 * at a space, which is dropped, or in the middle of a word that is wider than a row. `consumed` is how much of the line
 * the rows took; the rest fits in one row. Width is at least 2, so a wide character always fits.
 */
export function cutRows(line: string, width: number): { rows: string[]; consumed: number } {
    const rows: string[] = [];
    let start = 0;
    for (;;) {
        const overflow = overflowIndex(line, start, Math.max(2, width));
        if (overflow === line.length) return { rows, consumed: start };
        const { end, next } = breakAt(line, start, overflow);
        rows.push(displayRow(line.slice(start, end).trimEnd()));
        start = next;
    }
}
