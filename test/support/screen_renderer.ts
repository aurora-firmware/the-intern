/**
 * What a terminal shows after it has been written the given bytes. Tests that count the bytes of a chat can't tell an
 * answer that reads well from one cut by the input line, because readline moves the cursor and clears lines. This
 * interprets the sequences `bob chat` and readline emit: carriage return, line feed (as a terminal with output
 * post-processing does, so it also returns the carriage), backspace, tab, cursor movement (A, B, C, D, G, H), erase in
 * display (J) and in line (K), and automatic wrap at the last column. Other sequences, colours included, are ignored.
 *
 * The screen has a height. A line feed or a wrap on its last row scrolls it: the top row moves into the scrollback,
 * where no sequence reaches again. A cursor movement up stops at the top row and one down at the bottom row, and erase
 * in display clears the visible rows only. A wide character (two cells) that doesn't fit in the last column of a row
 * wraps whole. This is what a real terminal (checked against tmux) does, and what a redraw that climbs more rows than
 * the screen holds runs into. `isHomeClearKept` adds one tmux habit: clearing from the home position keeps the rows
 * in the scrollback, which xterm does not do.
 */

const ESC = "\u001b";
const TAB_WIDTH = 8;
const CSI_FINAL = /[@-~]/;
const DEFAULT_COLUMNS = 80;
const DEFAULT_HEIGHT = 24;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const WIDE = /^[\p{Emoji_Presentation}]$/u;
const WIDE_RANGES: [number, number][] = [
    [0x1100, 0x115f],
    [0x2e80, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd],
];

/** The cells a character takes: 0 for a combining mark, 2 for a wide one, else 1. */
function cellsOf(char: string): number {
    if (ZERO_WIDTH.test(char)) return 0;
    const code = char.codePointAt(0) as number;
    if (WIDE.test(char) || WIDE_RANGES.some(([from, to]) => code >= from && code <= to)) return 2;
    return 1;
}

type Cell = string;
/** The cell after a wide character's first one; it holds no text of its own. */
const SECOND_HALF = "";

export type RenderedScreen = {
    /** The scrollback and the visible rows, from the first one written, each without trailing spaces. */
    rows: string[];
    /** The rows joined with line feeds, without trailing blank rows. */
    text: string;
    /** The rows that scrolled off the top. */
    scrollback: string[];
    /** The rows a person sees: as many as the height, the last ones blank if nothing was written there. */
    screen: string[];
    /** The cursor's place on the visible screen. */
    cursor: { row: number; column: number };
};

export function renderTerminal(
    bytes: string,
    options: { columns?: number; height?: number; isHomeClearKept?: boolean } = {},
): RenderedScreen {
    const columns = options.columns ?? DEFAULT_COLUMNS;
    const height = options.height ?? DEFAULT_HEIGHT;
    const scrolled: Cell[][] = [];
    const grid: Cell[][] = Array.from({ length: height }, () => []);
    const cursor = { row: 0, column: 0 };
    let isWrapPending = false;

    const scroll = () => {
        scrolled.push(grid.shift() as Cell[]);
        grid.push([]);
    };
    const lineFeed = () => {
        if (cursor.row === height - 1) scroll();
        else cursor.row++;
    };
    const moveTo = (row: number, column: number) => {
        cursor.row = Math.min(Math.max(0, row), height - 1);
        cursor.column = Math.min(Math.max(0, column), columns - 1);
        isWrapPending = false;
    };
    const put = (char: string) => {
        const cells = cellsOf(char);
        if (cells === 0) return;
        if (isWrapPending || cursor.column + cells > columns) {
            lineFeed();
            cursor.column = 0;
            isWrapPending = false;
        }
        const row = grid[cursor.row] as Cell[];
        while (row.length < cursor.column) row.push(" ");
        row[cursor.column] = char;
        if (cells === 2) row[cursor.column + 1] = SECOND_HALF;
        cursor.column += cells;
        if (cursor.column >= columns) {
            cursor.column = columns - 1;
            isWrapPending = true;
        }
    };
    // tmux, asked to clear from the home position to the end of the screen, moves the rows to its history first.
    const keepScreen = () => {
        const used = grid.findLastIndex((row) => row.length > 0) + 1;
        for (let row = 0; row < used; row++) scrolled.push([...(grid[row] as Cell[])]);
    };
    const eraseInLine = (mode: number) => {
        const row = grid[cursor.row] as Cell[];
        if (mode === 0) row.length = Math.min(row.length, cursor.column);
        else if (mode === 1)
            for (let column = 0; column <= cursor.column && column < row.length; column++) row[column] = " ";
        else row.length = 0;
    };
    const eraseInDisplay = (mode: number) => {
        if (mode === 0) {
            if (options.isHomeClearKept && cursor.row === 0 && cursor.column === 0) keepScreen();
            eraseInLine(0);
            for (let row = cursor.row + 1; row < height; row++) (grid[row] as Cell[]).length = 0;
        } else if (mode === 2) {
            for (const row of grid) row.length = 0;
        }
    };
    const applySequence = (final: string, parameters: number[]) => {
        const first = parameters[0];
        const count = first === undefined || first === 0 ? 1 : first;
        if (final === "A") moveTo(cursor.row - count, cursor.column);
        else if (final === "B") moveTo(cursor.row + count, cursor.column);
        else if (final === "C") moveTo(cursor.row, cursor.column + count);
        else if (final === "D") moveTo(cursor.row, cursor.column - count);
        else if (final === "G") moveTo(cursor.row, count - 1);
        else if (final === "H")
            moveTo(count - 1, (parameters[1] === undefined || parameters[1] === 0 ? 1 : parameters[1]) - 1);
        else if (final === "J") eraseInDisplay(first ?? 0);
        else if (final === "K") eraseInLine(first ?? 0);
    };

    const chars = [...bytes];
    for (let index = 0; index < chars.length; index++) {
        const char = chars[index] as string;
        if (char === ESC && chars[index + 1] === "[") {
            let end = index + 2;
            while (end < chars.length && !CSI_FINAL.test(chars[end] as string)) end++;
            const parameters = chars
                .slice(index + 2, end)
                .join("")
                .replace(/^\?/, "")
                .split(";")
                .map((part) => Number.parseInt(part, 10) || 0);
            applySequence(chars[end] as string, parameters);
            index = end;
        } else if (char === "\r") moveTo(cursor.row, 0);
        else if (char === "\n") {
            lineFeed();
            moveTo(cursor.row, 0);
        } else if (char === "\b") moveTo(cursor.row, cursor.column - 1);
        else if (char === "\t") moveTo(cursor.row, (Math.floor(cursor.column / TAB_WIDTH) + 1) * TAB_WIDTH);
        else if (char >= " ") put(char);
    }

    const textOf = (row: Cell[]) => row.join("").trimEnd();
    const scrollback = scrolled.map(textOf);
    const screen = grid.map(textOf);
    const lastUsed = Math.max(
        cursor.row,
        screen.findLastIndex((row) => row !== ""),
    );
    const rows = [...scrollback, ...screen.slice(0, lastUsed + 1)];
    return { rows, text: rows.join("\n").trimEnd(), scrollback, screen, cursor: { ...cursor } };
}
