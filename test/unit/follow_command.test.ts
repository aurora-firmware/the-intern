/**
 * `bob follow` failing at its start (S-005 REQ-002, REQ-003): a relative runtime directory is a usage error, a feed
 * the service refuses is exit 1 with its code and message. Both go through the shared exit-code mapping.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { type CommandInput, type CommandIo, EXIT_CODES } from "../../src/cli/command_line.ts";
import { followCommand } from "../../src/cli/follow_commands.ts";

const DEADLINE_MS = 20_000;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

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

function inputOf(io: CommandIo, runtimeDir: string): CommandInput {
    return { positionals: [], options: {}, json: false, io, runtimeDir };
}

/** Runs the command, failing the test instead of hanging when it keeps following. */
async function runWithin(input: CommandInput): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("bob follow did not end")), DEADLINE_MS);
    });
    try {
        return await Promise.race([followCommand.run(input), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

async function runtimeDirRefusing(code: string, message: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bob-follow-"));
    const server: Server = createServer((_request, response) => {
        response.statusCode = 409;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { code, message } }));
    });
    await new Promise<void>((resolve) => server.listen(join(dir, "bob.sock"), resolve));
    cleanups.push(async () => {
        server.close();
        await rm(dir, { recursive: true, force: true });
    });
    return dir;
}

describe("bob follow at its start", () => {
    it("returns_2_with_one_line_when_the_runtime_directory_is_relative", async () => {
        const memory = memoryIo();

        const status = await runWithin(inputOf(memory.io, "relative/run"));

        assert.equal(status, EXIT_CODES.usage);
        assert.match(memory.stderr(), /^[^\n]*relative\/run[^\n]*absolute path[^\n]*\n$/);
        assert.equal(memory.stdout(), "");
    });

    it("returns_1_with_the_code_and_message_when_the_service_refuses_the_feed", async () => {
        const dir = await runtimeDirRefusing("conflict", "The feed is closed.");
        const memory = memoryIo();

        const status = await runWithin(inputOf(memory.io, dir));

        assert.equal(status, EXIT_CODES.refused);
        assert.equal(memory.stderr(), "conflict: The feed is closed.\n");
        assert.equal(memory.stdout(), "");
    });
});
