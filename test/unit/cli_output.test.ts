import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { type CommandInput, type CommandIo, EXIT_CODES } from "../../src/cli/command_line.ts";
import { resolveRuntimeDir, socketPathFor, UNREACHABLE_MESSAGE, withClient } from "../../src/cli/connection.ts";
import { paint, writeError, writeJson, writeLine } from "../../src/cli/output.ts";

type MemoryIo = { io: CommandIo; stdout: () => string; stderr: () => string };

function memoryIo(overrides: Partial<CommandIo> = {}): MemoryIo {
    const out = new PassThrough();
    const err = new PassThrough();
    let outText = "";
    let errText = "";
    out.on("data", (chunk) => {
        outText += chunk;
    });
    err.on("data", (chunk) => {
        errText += chunk;
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
        ...overrides,
    };
    return { io, stdout: () => outText, stderr: () => errText };
}

function inputOf(io: CommandIo, runtimeDir?: string): CommandInput {
    return { positionals: [], options: {}, json: false, io, ...(runtimeDir !== undefined && { runtimeDir }) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function runtimeDirWithServer(answer: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bob-cli-"));
    const server: Server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server.listen(join(dir, "bob.sock"), resolve));
    cleanups.push(async () => {
        server.close();
        await rm(dir, { recursive: true, force: true });
    });
    return dir;
}

describe("resolveRuntimeDir", () => {
    const homeDir = "/home/member";

    it("uses_the_flag_over_the_environment", () => {
        const dir = resolveRuntimeDir({ flag: "/run/flag", env: { BOB_RUNTIME_DIR: "/run/env" }, homeDir });
        assert.equal(dir, "/run/flag");
    });

    it("uses_BOB_RUNTIME_DIR_when_no_flag_is_given", () => {
        assert.equal(resolveRuntimeDir({ env: { BOB_RUNTIME_DIR: "/run/env" }, homeDir }), "/run/env");
    });

    it("uses_the_default_runtime_directory_when_neither_is_set", () => {
        const dir = resolveRuntimeDir({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, homeDir });
        assert.equal(dir, "/run/user/1000/the-intern");
    });

    it("falls_back_to_the_state_directory_run_folder_without_XDG_RUNTIME_DIR", () => {
        assert.equal(resolveRuntimeDir({ env: {}, homeDir }), "/home/member/.local/state/the-intern/run");
    });

    it("builds_the_socket_path_from_the_flag", () => {
        const { io } = memoryIo();
        assert.equal(socketPathFor(inputOf(io, "/run/flag")), "/run/flag/bob.sock");
    });

    it("builds_the_socket_path_from_the_environment", () => {
        const { io } = memoryIo({ env: { BOB_RUNTIME_DIR: "/run/env" } });
        assert.equal(socketPathFor(inputOf(io)), "/run/env/bob.sock");
    });
});

describe("withClient", () => {
    it("returns_3_and_names_the_socket_when_no_daemon_answers", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bob-cli-"));
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const memory = memoryIo();
        const status = await withClient(inputOf(memory.io, dir), (client) => client.invoke("status").then(() => 0));
        assert.equal(status, EXIT_CODES.unreachable);
        assert.equal(memory.stderr(), `${UNREACHABLE_MESSAGE(join(dir, "bob.sock"))}\n`);
        assert.equal(
            UNREACHABLE_MESSAGE("/x/bob.sock"),
            "The Intern isn't running here (/x/bob.sock); start it with `bob serve`",
        );
        assert.equal(memory.stdout(), "");
    });

    it("returns_1_and_writes_the_code_and_message_when_the_service_refuses", async () => {
        const dir = await runtimeDirWithServer({ error: { code: "not_found", message: "No such job." } });
        const memory = memoryIo();
        const status = await withClient(inputOf(memory.io, dir), (client) => client.invoke("jobs.show").then(() => 0));
        assert.equal(status, EXIT_CODES.refused);
        assert.equal(memory.stderr(), "not_found: No such job.\n");
        assert.equal(memory.stdout(), "");
    });

    it("returns_the_action_status_when_the_service_answers", async () => {
        const dir = await runtimeDirWithServer({ result: { ok: true } });
        const memory = memoryIo();
        let answer: unknown;
        const status = await withClient(inputOf(memory.io, dir), async (client) => {
            answer = await client.invoke("status");
            return 0;
        });
        assert.equal(status, EXIT_CODES.ok);
        assert.deepEqual(answer, { ok: true });
    });

    it("returns_2_and_writes_the_reason_when_the_runtime_directory_flag_is_relative", async () => {
        const memory = memoryIo();
        let isActionRun = false;
        const status = await withClient(inputOf(memory.io, "relative/run"), async () => {
            isActionRun = true;
            return 0;
        });
        assert.equal(status, EXIT_CODES.usage);
        assert.equal(isActionRun, false);
        assert.match(memory.stderr(), /relative\/run.*absolute path/);
        assert.equal(memory.stdout(), "");
    });

    it("returns_2_when_BOB_RUNTIME_DIR_is_relative", async () => {
        const memory = memoryIo({ env: { BOB_RUNTIME_DIR: "run" } });
        const status = await withClient(inputOf(memory.io), async () => 0);
        assert.equal(status, EXIT_CODES.usage);
        assert.match(memory.stderr(), /absolute path/);
    });
});

describe("output", () => {
    it("writes_a_json_value_as_one_line_of_JSON_stringify", () => {
        const memory = memoryIo();
        const value = { id: "J-1", tags: ["a", "b"], note: "line\nbreak" };
        writeJson(memory.io, value);
        assert.equal(memory.stdout(), `${JSON.stringify(value)}\n`);
        assert.equal(memory.stderr(), "");
    });

    it("writes_lines_to_standard_output_and_errors_to_standard_error", () => {
        const memory = memoryIo();
        writeLine(memory.io, "data");
        writeError(memory.io, "problem");
        assert.equal(memory.stdout(), "data\n");
        assert.equal(memory.stderr(), "problem\n");
    });

    it("adds_no_control_sequence_when_standard_output_is_not_a_terminal", () => {
        const { io } = memoryIo({ isStdoutTerminal: false });
        for (const style of ["bold", "dim", "red", "green", "yellow"] as const) {
            assert.equal(paint(io, "text", style), "text");
        }
    });

    it("adds_a_colour_sequence_that_resets_when_standard_output_is_a_terminal", () => {
        const { io } = memoryIo({ isStdoutTerminal: true });
        const painted = paint(io, "text", "red");
        assert.ok(painted.startsWith("\u001b["));
        assert.ok(painted.includes("text"));
        assert.ok(painted.endsWith("\u001b[0m"));
    });
});
