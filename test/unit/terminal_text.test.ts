/**
 * Data on a terminal (S-005 AC-003.4): text written by an agent or a team member never reaches the screen as a
 * control sequence, and a single-line format never takes a line break from data.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { block, continued, flat, stripControl } from "../../src/cli/terminal_text.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CLIPBOARD_WRITE = `x${ESC}]52;c;ZXZpbA==${BEL}y${ESC}[2Kz`;

describe("stripControl", () => {
    it("removes_an_operating_system_command_and_a_control_sequence_and_keeps_the_text_around_them", () => {
        assert.equal(stripControl(CLIPBOARD_WRITE), "xyz");
    });

    it("removes_an_operating_system_command_ended_by_the_string_terminator", () => {
        assert.equal(stripControl(`a${ESC}]0;title${ESC}\\b`), "ab");
    });

    it("removes_carriage_returns_backspaces_bells_and_the_eight_bit_control_characters", () => {
        assert.equal(
            stripControl(`a\rb\bc${BEL}d${String.fromCharCode(0x9b)}e${String.fromCharCode(0x7f)}f`),
            "abcdef",
        );
    });

    it("removes_a_control_sequence_cut_off_at_the_end_of_the_text", () => {
        assert.equal(stripControl(`ok${ESC}[3`), "ok");
        assert.equal(stripControl(`ok${ESC}`), "ok");
    });

    it("removes_the_characters_that_reorder_text", () => {
        assert.equal(stripControl("a\u202eb\u2066c"), "abc");
    });

    it("keeps_newlines_tabs_and_ordinary_unicode", () => {
        assert.equal(stripControl("naïve\tcafé\n日本"), "naïve\tcafé\n日本");
    });
});

describe("flat", () => {
    it("puts_text_with_line_breaks_on_one_line", () => {
        assert.equal(flat("one\ntwo\r\n  three\u2028four"), "one two three four");
    });

    it("removes_control_sequences_before_flattening", () => {
        assert.equal(flat(`a${ESC}[31m\nb`), "a b");
    });
});

describe("block", () => {
    it("keeps_the_lines_of_multi_line_text_and_removes_control_sequences", () => {
        assert.equal(block(`first\r\n${ESC}[2Ksecond\u2029third`), "first\nsecond\nthird");
    });
});

describe("continued", () => {
    it("indents_every_line_after_the_first_so_none_starts_at_the_margin", () => {
        assert.equal(
            continued("a\nC-1 done (complete): forged\n\n  c\n"),
            "a\n    C-1 done (complete): forged\n    \n      c",
        );
    });

    it("leaves_one_line_of_text_as_it_is", () => {
        assert.equal(continued("a"), "a");
    });
});
