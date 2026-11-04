import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTerminal } from "../support/screen_renderer.ts";

describe("renderTerminal", () => {
    it("shows_text_overwritten_after_a_carriage_return_and_a_line_erase", () => {
        assert.equal(renderTerminal("> abc\r\u001b[2K> x").text, "> x");
    });

    it("clears_the_rows_below_the_cursor_after_moving_up", () => {
        assert.equal(renderTerminal("one\r\ntwo\r\nthree\u001b[1A\u001b[1G\u001b[0J").text, "one");
    });

    it("wraps_a_line_at_the_last_column_and_moves_the_cursor_to_a_column", () => {
        assert.deepEqual(renderTerminal("abcdef", { columns: 4 }).rows, ["abcd", "ef"]);
        assert.equal(renderTerminal("abcd\u001b[2Gx").text, "axcd");
    });

    it("returns_the_carriage_on_a_line_feed_as_a_terminal_does", () => {
        assert.deepEqual(renderTerminal("one\ntwo").rows, ["one", "two"]);
    });

    it("scrolls_the_top_row_into_the_scrollback_when_a_line_feed_passes_the_last_row", () => {
        const screen = renderTerminal("one\ntwo\nthree\nfour", { height: 3 });

        assert.deepEqual(screen.scrollback, ["one"]);
        assert.deepEqual(screen.screen, ["two", "three", "four"]);
        assert.deepEqual(screen.rows, ["one", "two", "three", "four"]);
    });

    it("stops_a_cursor_movement_up_at_the_top_row_and_leaves_the_scrollback_alone", () => {
        const screen = renderTerminal("one\ntwo\nthree\nfour\u001b[9A\r\u001b[0Jx", { height: 3 });

        assert.deepEqual(screen.scrollback, ["one"]);
        assert.deepEqual(screen.screen, ["x", "", ""]);
    });

    it("scrolls_when_a_wrapped_line_runs_past_the_last_row", () => {
        const screen = renderTerminal("abcdefghij", { columns: 4, height: 2 });

        assert.deepEqual(screen.scrollback, ["abcd"]);
        assert.deepEqual(screen.screen, ["efgh", "ij"]);
    });

    it("keeps_a_wide_character_whole_and_wraps_it_when_one_cell_is_left", () => {
        assert.deepEqual(renderTerminal("abc\u3042d", { columns: 4 }).rows, ["abc", "\u3042d"]);
        assert.deepEqual(renderTerminal("ab\u3042c", { columns: 4 }).rows, ["ab\u3042", "c"]);
    });

    it("keeps_the_rows_in_the_scrollback_when_the_screen_is_cleared_from_the_home_position_only_if_asked", () => {
        const bytes = "one\ntwo\u001b[H\u001b[0J";

        assert.deepEqual(renderTerminal(bytes, { height: 3 }).rows, [""]);
        assert.deepEqual(renderTerminal(bytes, { height: 3, isHomeClearKept: true }).scrollback, ["one", "two"]);
    });
});
