/**
 * The `bob` command table (S-005 REQ-001). It imports no daemon module: a command that needs the daemon's code loads it
 * inside its `run`, so a command that only calls the service never pays for it (S-005 REQ-016).
 */
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { statusCommand, usageCommand } from "./instance_commands.ts";
import type { ServeFlags } from "./serve.ts";

const DIRECTORY_FLAG_NAMES = ["config-dir", "state-dir", "data-dir"] as const;

// The parser lifts --runtime-dir out of the options, since every service command shares it.
function serveFlagsOf(input: CommandInput): ServeFlags {
    const { options, runtimeDir } = input;
    const flags: ServeFlags = {};
    for (const name of DIRECTORY_FLAG_NAMES) {
        const value = options[name];
        if (typeof value === "string") flags[name] = value;
    }
    if (runtimeDir !== undefined) flags["runtime-dir"] = runtimeDir;
    if (typeof options.verbose === "boolean") flags.verbose = options.verbose;
    return flags;
}

const serve: CommandSpec = {
    verb: "serve",
    summary: "Run the daemon in the foreground.",
    positionals: [],
    options: {
        "config-dir": { type: "string", description: "The configuration directory." },
        "state-dir": { type: "string", description: "The state directory." },
        "data-dir": { type: "string", description: "The data directory." },
        "runtime-dir": { type: "string", description: "The runtime directory." },
        verbose: { type: "boolean", description: "Write debug lines to standard error." },
    },
    isData: false,
    callsService: false,
    async run(input) {
        const { runServe } = await import("./serve.ts");
        return runServe(serveFlagsOf(input));
    },
};

export const COMMANDS: readonly CommandSpec[] = [serve, statusCommand, usageCommand];
