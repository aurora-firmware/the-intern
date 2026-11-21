/**
 * How `bob mail` reads a secret (S-009 REQ-017): on a terminal without echo, or from standard input to its end.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { readSecret } from "../../src/cli/secret_prompt.ts";

type FakeStdin = PassThrough & { setRawMode(mode: boolean): void; rawModes: boolean[] };

function fakeStdin(): FakeStdin {
    const stdin = new PassThrough() as FakeStdin;
    stdin.rawModes = [];
    stdin.setRawMode = (mode) => {
        stdin.rawModes.push(mode);
    };
    return stdin;
}

function ioWith(stdin: PassThrough, isStdinTerminal: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk) => out.push(String(chunk)));
    stderr.on("data", (chunk) => err.push(String(chunk)));
    const io: CommandIo = {
        stdout,
        stderr,
        stdin,
        env: {},
        cwd: "/",
        homeDir: "/",
        isStdoutTerminal: true,
        isStdinTerminal,
    };
    return { io, shown: () => [...out, ...err].join("") };
}

describe("a secret read from a terminal", () => {
    it("echoes_nothing_and_returns_the_typed_line_in_raw_mode_restored_afterwards", async () => {
        const stdin = fakeStdin();
        const { io, shown } = ioWith(stdin, true);
        const pending = readSecret({ io, prompt: "Password: ", fromStdin: false });
        stdin.write("hun");
        stdin.write("ter2\r");
        assert.equal(await pending, "hunter2");
        assert.deepEqual(stdin.rawModes, [true, false]);
        assert.ok(shown().includes("Password: "));
        assert.ok(!shown().includes("hunter2"));
        assert.ok(!shown().includes("hun"));
    });

    it("lets_backspace_remove_the_last_typed_character", async () => {
        const stdin = fakeStdin();
        const { io } = ioWith(stdin, true);
        const pending = readSecret({ io, prompt: "Password: ", fromStdin: false });
        stdin.write("abcx\u007fd\n");
        assert.equal(await pending, "abcd");
    });

    it("refuses_when_interrupted_and_restores_the_terminal", async () => {
        const stdin = fakeStdin();
        const { io } = ioWith(stdin, true);
        const pending = readSecret({ io, prompt: "Password: ", fromStdin: false });
        stdin.write("ab\u0003");
        await assert.rejects(pending, /interrupted/);
        assert.deepEqual(stdin.rawModes, [true, false]);
    });

    it("refuses_when_input_ends_before_a_line_is_typed", async () => {
        const stdin = fakeStdin();
        const { io } = ioWith(stdin, true);
        const pending = readSecret({ io, prompt: "Password: ", fromStdin: false });
        stdin.end();
        await assert.rejects(pending, /ended/);
        assert.deepEqual(stdin.rawModes, [true, false]);
    });

    it("refuses_without_a_terminal_when_the_secret_is_not_read_from_standard_input", async () => {
        const stdin = new PassThrough();
        const { io } = ioWith(stdin, false);
        await assert.rejects(readSecret({ io, prompt: "Password: ", fromStdin: false }), /--secret-stdin/);
    });
});

describe("a secret read from standard input", () => {
    it("returns_all_of_standard_input_without_one_trailing_line_end", async () => {
        const stdin = new PassThrough();
        const { io, shown } = ioWith(stdin, false);
        const pending = readSecret({ io, prompt: "Password: ", fromStdin: true });
        stdin.write("pass");
        stdin.end("word\n");
        assert.equal(await pending, "password");
        assert.equal(shown(), "");
    });

    it("removes_a_carriage_return_line_end_as_one_line_end", async () => {
        const stdin = new PassThrough();
        const { io } = ioWith(stdin, false);
        const pending = readSecret({ io, prompt: "", fromStdin: true });
        stdin.end("pw\r\n");
        assert.equal(await pending, "pw");
    });

    it("keeps_all_but_one_of_several_trailing_line_ends", async () => {
        const stdin = new PassThrough();
        const { io } = ioWith(stdin, false);
        const pending = readSecret({ io, prompt: "", fromStdin: true });
        stdin.end("pw\n\n");
        assert.equal(await pending, "pw\n");
    });

    it("keeps_a_secret_with_no_trailing_line_end_whole", async () => {
        const stdin = new PassThrough();
        const { io } = ioWith(stdin, false);
        const pending = readSecret({ io, prompt: "", fromStdin: true });
        stdin.end("pw");
        assert.equal(await pending, "pw");
    });

    it("refuses_an_empty_standard_input", async () => {
        const stdin = new PassThrough();
        const { io } = ioWith(stdin, false);
        const pending = readSecret({ io, prompt: "", fromStdin: true });
        stdin.end();
        await assert.rejects(pending, /empty/);
    });
});
