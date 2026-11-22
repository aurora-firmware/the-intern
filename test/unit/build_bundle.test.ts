import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    applyPatches,
    assertArchiveSize,
    bundleName,
    checksumLine,
    launcherScript,
    MAX_ARCHIVE_BYTES,
} from "../../release/build_bundle.ts";
import { scaled } from "../support/time_scale.ts";

describe("bundle builder names and checksums", () => {
    it("names the archive for linux-x64", () => {
        assert.equal(bundleName("0.1.0", "linux-x64"), "the-intern-0.1.0-linux-x64.tar.gz");
    });

    it("names the archive for darwin-arm64", () => {
        assert.equal(bundleName("1.2.3-rc.1", "darwin-arm64"), "the-intern-1.2.3-rc.1-darwin-arm64.tar.gz");
    });

    it("writes a checksum line that sha256sum accepts for the archive it names", () => {
        const dir = mkdtempSync(join(tmpdir(), "bundle-sum-"));
        try {
            const name = "the-intern-0.1.0-linux-x64.tar.gz";
            writeFileSync(join(dir, name), "archive bytes");
            const hex = createHash("sha256").update("archive bytes").digest("hex");
            writeFileSync(join(dir, `${name}.sha256`), checksumLine(hex, name));
            const check = spawnSync("sha256sum", ["-c", `${name}.sha256`], {
                cwd: dir,
                encoding: "utf8",
                timeout: scaled(10000),
            });
            assert.equal(check.status, 0, check.stdout + check.stderr);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("bundle builder patches", () => {
    it("replaces the text that matches once", () => {
        const result = applyPatches({ "src/a.ts": "one two three" }, [{ file: "src/a.ts", find: "two", replace: "2" }]);
        assert.deepEqual(result, { "src/a.ts": "one 2 three" });
    });

    it("fails naming the file and the text when the text matches zero times", () => {
        assert.throws(
            () => applyPatches({ "src/a.ts": "one" }, [{ file: "src/a.ts", find: "missing", replace: "x" }]),
            /src\/a\.ts.*missing.*0 times/s,
        );
    });

    it("fails naming the file and the text when the text matches more than once", () => {
        assert.throws(
            () => applyPatches({ "src/a.ts": "ab ab" }, [{ file: "src/a.ts", find: "ab", replace: "x" }]),
            /src\/a\.ts.*ab.*2 times/s,
        );
    });

    it("fails when the file is not in the bundle", () => {
        assert.throws(() => applyPatches({}, [{ file: "src/none.ts", find: "a", replace: "b" }]), /src\/none\.ts/);
    });
});

describe("bundle builder archive size", () => {
    it("accepts an archive of exactly 150 MB", () => {
        assert.doesNotThrow(() => assertArchiveSize("a.tar.gz", MAX_ARCHIVE_BYTES));
    });

    it("fails naming the file and the size when the archive is over 150 MB", () => {
        assert.throws(() => assertArchiveSize("a.tar.gz", MAX_ARCHIVE_BYTES + 1), /a\.tar\.gz.*157286401/s);
    });
});

describe("bundle launcher", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "bundle-launcher-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("runs its own real folder's node and bob.ts with its arguments when run through a link", () => {
        const root = join(dir, "versions", "0.1.0");
        mkdirSync(join(root, "bin"), { recursive: true });
        mkdirSync(join(root, "node", "bin"), { recursive: true });
        mkdirSync(join(root, "app", "src", "cli"), { recursive: true });
        writeFileSync(join(root, "bin", "bob"), launcherScript());
        chmodSync(join(root, "bin", "bob"), 0o755);
        writeFileSync(join(root, "node", "bin", "node"), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
        chmodSync(join(root, "node", "bin", "node"), 0o755);
        mkdirSync(join(dir, "linkdir"));
        symlinkSync(join(root, "bin", "bob"), join(dir, "linkdir", "bob"));
        symlinkSync(join(dir, "linkdir", "bob"), join(dir, "second"));

        const result = spawnSync(join(dir, "second"), ["status", "two words"], {
            cwd: dir,
            encoding: "utf8",
            timeout: scaled(10000),
        });

        assert.equal(result.status, 0, result.stderr);
        const lines = result.stdout.trimEnd().split("\n");
        assert.deepEqual(lines, [join(root, "bin", "..", "app", "src", "cli", "bob.ts"), "status", "two words"]);
    });

    it("is a POSIX sh script", () => {
        assert.match(launcherScript(), /^#!\/bin\/sh\n/);
    });
});
