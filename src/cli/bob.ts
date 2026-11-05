/**
 * The `bob` command line (S-005 REQ-001). `main` parses the arguments against the command table, prints help, usage
 * errors and reserved-group notices, and otherwise runs the command. Run it as `node src/cli/bob.ts <command>` until
 * the release form provides a `bob` launcher.
 */
import { homedir } from "node:os";
import { type CommandIo, EXIT_CODES, parseCommandLine } from "./command_line.ts";
import { COMMANDS } from "./commands.ts";

function processIo(): CommandIo {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        env: process.env,
        cwd: process.cwd(),
        homeDir: homedir(),
        isStdoutTerminal: process.stdout.isTTY === true,
        isStdinTerminal: process.stdin.isTTY === true,
    };
}

// Resolves once the stream has taken everything written so far, or has failed (a reader that closed early).
function drained(stream: CommandIo["stdout"]): Promise<void> {
    return new Promise((resolve) => {
        stream.on("error", () => resolve());
        stream.write("", () => resolve());
    });
}

/**
 * Resolves when a reader of standard output or standard error has gone (`EPIPE`), and rejects with any other stream
 * failure. The listeners stay on for the life of the process, so no error event finds a stream without one.
 */
function whenReaderGone(io: CommandIo): Promise<void> {
    const gone = Promise.withResolvers<void>();
    const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") gone.resolve();
        else gone.reject(error);
    };
    io.stdout.on("error", onError);
    io.stderr.on("error", onError);
    return gone.promise;
}

/** Runs the command to its status, or to success when its reader goes away first. */
function runUntilReaderGone(command: () => Promise<number>, io: CommandIo): Promise<number> {
    return Promise.race([command(), whenReaderGone(io).then(() => EXIT_CODES.ok)]);
}

/** Runs the command and returns the process exit status. */
export async function main(argv: readonly string[], io: CommandIo = processIo()): Promise<number> {
    const parsed = parseCommandLine(argv, COMMANDS);
    switch (parsed.kind) {
        case "help":
            io.stdout.write(parsed.usage);
            return EXIT_CODES.ok;
        case "usage-error":
            io.stderr.write(`${parsed.message}\n${parsed.usage}`);
            return EXIT_CODES.usage;
        case "reserved-group":
            io.stderr.write(`${parsed.message}\n`);
            return EXIT_CODES.usage;
        case "command": {
            const run = () => parsed.command.run({ ...parsed.input, io });
            // `serve` keeps its own reaction to a lost stream; a data command ends quietly when its reader goes.
            const status = parsed.command.isData ? await runUntilReaderGone(run, io) : await run();
            // A piped stream holds only what the reader has taken, so exiting at once would cut data commands short.
            // The error listener comes after the command, so `serve` reacts to a lost stderr as before.
            if (parsed.command.isData) await Promise.all([drained(io.stdout), drained(io.stderr)]);
            return status;
        }
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
    // Open handles of a stopped daemon must not keep the process alive past its settled status.
    process.exit();
}
