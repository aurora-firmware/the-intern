import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cellsOf, displayRow, lastRow } from "../../src/cli/text_rows.ts";

describe("lastRow", () => {
    it("returns_the_whole_line_when_it_fits_the_width", () => {
        assert.equal(lastRow("one two", 7), "one two");
    });

    it("returns_the_last_part_that_fits_and_cuts_in_the_middle_of_a_word", () => {
        assert.equal(lastRow("one two three", 8), "wo three");
        assert.equal(lastRow("abcdefghij", 4), "ghij");
    });

    it("counts_a_wide_character_as_two_cells_and_a_combining_mark_as_none", () => {
        assert.equal(cellsOf("あ"), 2);
        assert.equal(cellsOf("\u{1F600}"), 2);
        assert.equal(cellsOf("\u0301"), 0);
        assert.equal(lastRow("あいうえお", 6), "うえお");
        assert.equal(lastRow("あいうえお", 5), "えお");
    });

    it("keeps_a_surrogate_pair_whole", () => {
        assert.equal(lastRow("a\u{1F600}\u{1F600}b", 4), "\u{1F600}b");
    });

    it("counts_a_tab_as_the_four_spaces_it_is_shown_as", () => {
        assert.equal(lastRow("ab\tcd", 7), "b    cd");
        assert.equal(displayRow("a\tb"), "a    b");
    });

    it("returns_a_row_of_at_least_one_wide_character_whatever_the_width", () => {
        assert.equal(lastRow("あい", 1), "い");
    });

    it("returns_an_empty_row_for_an_empty_line", () => {
        assert.equal(lastRow("", 10), "");
    });
});
