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
            const status = await parsed.command.run({ ...parsed.input, io });
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
