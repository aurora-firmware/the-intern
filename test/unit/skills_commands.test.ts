import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { main } from "../../src/cli/bob.ts";
import type { CommandIo } from "../../src/cli/command_line.ts";

function memoryIo() {
    const out = new PassThrough();
    const err = new PassThrough();
    let stdout = "";
    let stderr = "";
    out.on("data", (chunk) => {
        stdout += chunk;
    });
    err.on("data", (chunk) => {
        stderr += chunk;
    });
    const io: CommandIo = {
        stdout: out,
        stderr: err,
        stdin: new PassThrough(),
        env: {},
        cwd: "/work",
        homeDir: "/home/member",
        isStdoutTerminal: false,
        isStdinTerminal: false,
    };
    return { io, stdout: () => stdout, stderr: () => stderr };
}

const ONE_OF_FLAGS = /exactly one of --role or --conversation/i;

describe("bob skills usage errors", () => {
    const cases: [string, string[]][] = [
        ["list with no flag", ["skills", "list"]],
        ["list with both flags", ["skills", "list", "--role", "gp", "--conversation", "5"]],
        ["enable with no flag", ["skills", "enable", "code-review"]],
        ["enable with both flags", ["skills", "enable", "code-review", "--role", "gp", "--conversation", "5"]],
        ["disable with no flag", ["skills", "disable", "code-review"]],
        ["disable with both flags", ["skills", "disable", "code-review", "--role", "gp", "--conversation", "5"]],
    ];
    for (const [name, argv] of cases) {
        it(`prints usage on standard error and exits 2 for ${name}`, async () => {
            const { io, stdout, stderr } = memoryIo();

            const status = await main(argv, io);

            assert.equal(status, 2);
            assert.equal(stdout(), "");
            assert.match(stderr(), ONE_OF_FLAGS);
            assert.match(stderr(), /Usage: bob skills/);
        });
    }
});
