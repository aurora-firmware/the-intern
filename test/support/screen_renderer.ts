/**
 * What a terminal shows after it has been written the given bytes. Tests that count the bytes of a chat can't tell an
 * answer that reads well from one cut by the input line, because readline moves the cursor and clears lines. This
 * interprets the sequences `bob chat` and readline emit: carriage return, line feed (as a terminal with output
 * post-processing does, so it also returns the carriage), backspace, tab, cursor movement (A, B, C, D, G, H), erase in
 * display (J) and in line (K), and automatic wrap at the last column. Other sequences, colours included, are ignored.
 * The screen never scrolls: rows are counted from the first one written.
 */

const ESC = "\u001b";
const TAB_WIDTH = 8;
const CSI_FINAL = /[@-~]/;

type Cursor = { row: number; column: number };

export type RenderedScreen = {
    /** The rows from the top, each without trailing spaces. */
    rows: string[];
    /** The rows joined with line feeds, without trailing blank rows. */
    text: string;
};

export function renderTerminal(bytes: string, options: { columns?: number } = {}): RenderedScreen {
    const columns = options.columns ?? 80;
    const grid: string[][] = [[]];
    const cursor: Cursor = { row: 0, column: 0 };
    let isWrapPending = false;

    const rowAt = (row: number): string[] => {
        while (grid.length <= row) grid.push([]);
        return grid[row] as string[];
    };
    const moveTo = (row: number, column: number) => {
        cursor.row = Math.max(0, row);
        cursor.column = Math.min(Math.max(0, column), columns - 1);
        isWrapPending = false;
        rowAt(cursor.row);
    };
    const put = (char: string) => {
        if (isWrapPending) moveTo(cursor.row + 1, 0);
        const row = rowAt(cursor.row);
        while (row.length < cursor.column) row.push(" ");
        row[cursor.column] = char;
        if (cursor.column === columns - 1) isWrapPending = true;
        else cursor.column++;
    };
    const eraseInLine = (mode: number) => {
        const row = rowAt(cursor.row);
        if (mode === 0) row.length = Math.min(row.length, cursor.column);
        else if (mode === 1)
            for (let column = 0; column <= cursor.column && column < row.length; column++) row[column] = " ";
        else row.length = 0;
    };
    const eraseInDisplay = (mode: number) => {
        if (mode === 0) {
            eraseInLine(0);
            grid.length = cursor.row + 1;
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

    for (let index = 0; index < bytes.length; index++) {
        const char = bytes.charAt(index);
        if (char === ESC && bytes.charAt(index + 1) === "[") {
            let end = index + 2;
            while (end < bytes.length && !CSI_FINAL.test(bytes.charAt(end))) end++;
            const parameters = bytes
                .slice(index + 2, end)
                .replace(/^\?/, "")
                .split(";")
                .map((part) => Number.parseInt(part, 10) || 0);
            applySequence(bytes.charAt(end), parameters);
            index = end;
        } else if (char === "\r") moveTo(cursor.row, 0);
        else if (char === "\n") moveTo(cursor.row + 1, 0);
        else if (char === "\b") moveTo(cursor.row, cursor.column - 1);
        else if (char === "\t") moveTo(cursor.row, (Math.floor(cursor.column / TAB_WIDTH) + 1) * TAB_WIDTH);
        else if (char >= " ") put(char);
    }

    const rows = grid.map((row) => row.join("").trimEnd());
    return { rows, text: rows.join("\n").trimEnd() };
}
