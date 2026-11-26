import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkReleaseTag } from "../../release/check_release.ts";
import { scaled } from "../support/time_scale.ts";

const PACKAGE_VERSION = (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
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

    describe("in a folder that git rejects or a repository without origin/main", () => {
        const root = mkdtempSync(join(tmpdir(), "check-release-"));
        after(() => rmSync(root, { recursive: true, force: true }));

        function runScript(cwd: string) {
            return spawnSync(process.execPath, [SCRIPT, `v${PACKAGE_VERSION}`], {
                cwd,
                encoding: "utf8",
                timeout: scaled(30_000),
                env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
            });
        }

        it("reports git's own error, not 'not on main', when git fails for another reason", () => {
            const folder = join(root, "not-a-repository");
            mkdirSync(folder);
            const run = runScript(folder);
            assert.equal(run.status, 1);
            assert.match(run.stderr, /not a git repository/);
            assert.doesNotMatch(run.stderr, /is not on main/);
        });

        it("still refuses a commit that is not an ancestor of origin/main", () => {
            const folder = join(root, "diverged");
            mkdirSync(folder);
            const git = (...args: string[]) =>
                spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
                    cwd: folder,
                    encoding: "utf8",
                });
            git("init", "-q");
            git("commit", "-q", "--allow-empty", "-m", "main");
            git("update-ref", "refs/remotes/origin/main", "HEAD");
            git("commit", "-q", "--allow-empty", "-m", "ahead of main");
            const run = runScript(folder);
            assert.equal(run.status, 1);
            assert.match(run.stderr, /is not on main/);
        });
    });
});
