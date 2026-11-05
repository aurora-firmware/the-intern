import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../../docs/manual/.vitepress/config.ts";

// GitHub Pages serves this project's site under /the-intern/, so the build must carry that prefix.
test("manual site is built for the GitHub Pages project path", () => {
    assert.equal(config.base, "/the-intern/");
});
