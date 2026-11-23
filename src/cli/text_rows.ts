/**
 * What a screen needs to know of text in terminal cells, without asking the terminal: how wide a character is and which
 * part of a line fits one row. A cell count is an estimate: a combining mark takes none, and an emoji or an East Asian
 * wide character two. Imports nothing.
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

/**
 * The last part of a line that fits in `width` cells, tabs shown as spaces: the row a screen shows of a line that is
 * still being written. A line that fits is returned whole. Width is at least 2, so a wide character always fits.
 */
export function lastRow(line: string, width: number): string {
    const text = displayRow(line);
    const characters = [...text];
    let used = 0;
    let first = characters.length;
    while (first > 0) {
        used += cellsOf(characters[first - 1] as string);
        if (used > Math.max(2, width)) break;
        first--;
    }
    return characters.slice(first).join("");
}
