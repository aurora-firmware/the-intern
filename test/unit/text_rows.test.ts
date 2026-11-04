import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cellsOf, cutRows, displayRow } from "../../src/cli/text_rows.ts";

describe("cutRows", () => {
    it("returns_no_row_when_the_line_fits_the_width", () => {
        assert.deepEqual(cutRows("one two", 7), { rows: [], consumed: 0 });
    });

    it("cuts_a_row_at_the_last_space_that_fits_and_drops_the_space", () => {
        assert.deepEqual(cutRows("one two three", 8), { rows: ["one two"], consumed: 8 });
    });

    it("cuts_at_the_space_that_follows_a_row_filled_exactly", () => {
        assert.deepEqual(cutRows("one two three", 7), { rows: ["one two"], consumed: 8 });
    });

    it("cuts_in_the_middle_of_a_word_wider_than_a_row", () => {
        assert.deepEqual(cutRows("abcdefghij", 4), { rows: ["abcd", "efgh"], consumed: 8 });
    });

    it("counts_a_wide_character_as_two_cells_and_a_combining_mark_as_none", () => {
        assert.equal(cellsOf("あ"), 2);
        assert.equal(cellsOf("\u{1F600}"), 2);
        assert.equal(cellsOf("é".slice(1)), 0);
        assert.deepEqual(cutRows("あいうえお", 6), { rows: ["あいう"], consumed: 3 });
    });

    it("counts_a_tab_as_the_four_spaces_it_is_shown_as", () => {
        assert.deepEqual(cutRows("ab\tcd", 7), { rows: ["ab    c"], consumed: 4 });
        assert.equal(displayRow("a\tb"), "a    b");
    });

    it("gives_the_same_rows_for_a_line_as_it_grows_so_a_row_once_cut_stays", () => {
        const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        const whole = cutRows(text, 12);
        for (let length = 1; length <= text.length; length++) {
            const part = cutRows(text.slice(0, length), 12);
            assert.deepEqual(part.rows, whole.rows.slice(0, part.rows.length));
        }
    });
});
