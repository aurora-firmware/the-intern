import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToText } from "../../src/mail/html_text.ts";

describe("htmlToText", () => {
    it("drops_the_content_of_script_and_style", () => {
        const html =
            "<html><head><style>p { color: red }</style></head><body><p>Hello</p>" +
            "<script>alert('secret')</script></body></html>";
        const text = htmlToText(html);
        assert.equal(text, "Hello");
    });

    it("turns_block_ends_and_br_into_line_breaks", () => {
        assert.equal(htmlToText("<p>One</p><p>Two<br>Three</p><div>Four</div>"), "One\nTwo\nThree\nFour");
    });

    it("removes_tags_and_decodes_entities", () => {
        assert.equal(
            htmlToText("<b>Fish &amp; chips</b> &lt;3 &#65;&#x42; &nbsp;done&quot;"),
            'Fish & chips <3 AB  done"',
        );
    });

    it("drops_script_content_regardless_of_case_and_attributes", () => {
        assert.equal(htmlToText('a<SCRIPT type="x">bad()</SCRIPT>b<Style media="all">.x{}</Style>c'), "abc");
    });
});
