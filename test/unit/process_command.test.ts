import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { processCommand } from "../support/process_command.ts";

describe("processCommand", () => {
    it("returns the full command line of a running process", () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "marker-argument"], {
            stdio: "ignore",
        });
        try {
            assert.match(processCommand(child.pid as number) ?? "", /marker-argument/);
        } finally {
            child.kill("SIGKILL");
        }
    });

    it("returns undefined for a process that has ended", async () => {
        const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        await new Promise((resolve) => child.once("exit", resolve));
        assert.equal(processCommand(child.pid as number), undefined);
    });

    it("throws instead of reporting a gone process when ps cannot be run", () => {
        assert.throws(() => processCommand(process.pid, "/nonexistent/ps"), /cannot look up process/);
    });
});
