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
});
