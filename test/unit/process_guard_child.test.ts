import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const GUARD_ENTRY = join(import.meta.dirname, "..", "support", "process_guard_child.ts");

describe("the process guard when it cannot look the process up", () => {
    it("exits 1 and leaves both the process and the hermetic root alone", async () => {
        const root = mkdtempSync(join(tmpdir(), "guard-root-"));
        const emptyPath = mkdtempSync(join(tmpdir(), "guard-nopath-"));
        const daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", root], { stdio: "ignore" });
        try {
            // With no ps on PATH, the lookup cannot run.
            const guard = fork(GUARD_ENTRY, [String(daemon.pid), root], {
                env: { ...process.env, PATH: emptyPath },
                stdio: ["ignore", "ignore", "ignore", "ipc"],
            });
            const exitCode = new Promise((resolve) => guard.once("exit", resolve));
            guard.disconnect();
            assert.equal(await exitCode, 1);
            assert.equal(daemon.exitCode, null, "the guard must not kill a process it could not identify");
            assert.equal(existsSync(root), true, "the guard must not remove the root under a process that may run");
        } finally {
            daemon.kill("SIGKILL");
            rmSync(root, { recursive: true, force: true });
            rmSync(emptyPath, { recursive: true, force: true });
        }
    });
});
