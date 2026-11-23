import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { checkReleaseTag } from "../../release/check_release.ts";
import { scaled } from "../support/time_scale.ts";

const SCRIPT = new URL("../../release/check_release.ts", import.meta.url).pathname;

describe("release check of the tag", () => {
    it("accepts the tag that is v plus the package version on main", () => {
        const result = checkReleaseTag({ tag: "v0.1.0", packageVersion: "0.1.0", isOnMain: true });
        assert.deepEqual(result, { ok: true, version: "0.1.0", isPrerelease: false });
    });

    it("marks a tag with the same pre-release part as a pre-release", () => {
        const result = checkReleaseTag({ tag: "v0.1.0-rc.1", packageVersion: "0.1.0-rc.1", isOnMain: true });
        assert.deepEqual(result, { ok: true, version: "0.1.0-rc.1", isPrerelease: true });
    });

    it("refuses a tag whose version differs, naming both versions", () => {
        const result = checkReleaseTag({ tag: "v0.2.0", packageVersion: "0.1.0", isOnMain: true });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("v0.2.0") && result.reason.includes("0.1.0"), "names both");
    });

    it("refuses a tag whose pre-release part differs", () => {
        const result = checkReleaseTag({ tag: "v0.1.0-rc.2", packageVersion: "0.1.0-rc.1", isOnMain: true });
        assert.equal(result.ok, false);
    });

    it("refuses a tag without the v", () => {
        const result = checkReleaseTag({ tag: "0.1.0", packageVersion: "0.1.0", isOnMain: true });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("0.1.0"));
    });

    it("refuses a tag that is not a version, naming the tag and the package version", () => {
        const result = checkReleaseTag({ tag: "vnext", packageVersion: "0.1.0", isOnMain: true });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("vnext") && result.reason.includes("0.1.0"));
    });

    it("refuses a tagged commit that is not on main", () => {
        const result = checkReleaseTag({ tag: "v0.1.0", packageVersion: "0.1.0", isOnMain: false });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("main"));
    });

    it("prints the reason to standard error and exits 1 when run with a refused tag", () => {
        const run = spawnSync(process.execPath, [SCRIPT, "vnext"], { encoding: "utf8", timeout: scaled(30_000) });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /vnext/);
        assert.equal(run.stdout, "");
    });
});
