import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function runInShell(command: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env: process.env });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

test("the rig runs the tests as the account tester", () => {
    assert.equal(runInShell("id -un").stdout, "tester");
});

test("systemd runs as the container's init", () => {
    assert.equal(runInShell("cat /proc/1/comm").stdout, "systemd");
});

test("the user manager of tester answers systemctl --user", () => {
    const result = runInShell("systemctl --user is-system-running");
    assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
    assert.equal(result.stdout, "running");
});

test("the commands' PATH finds no node", () => {
    assert.equal(runInShell("command -v node").status, 1);
});

test("tester has no sudo rights", () => {
    const result = runInShell("sudo -n true");
    assert.notEqual(result.status, 0);
});
