/**
 * The `bob` command table and its parser (S-005 REQ-001, REQ-003). Pure: it reads no process state and writes nothing.
 * It turns an argument list into one of four results (help, usage error, reserved group, command); the caller prints
 * and sets the exit code.
 */
import { parseArgs } from "node:util";

export const RESERVED_GROUPS: readonly string[] = [
    "schedules",
    "triggers",
    "skills",
    "instructions",
    "knowledge",
    "mail",
];

export const EXIT_CODES = { ok: 0, refused: 1, usage: 2, unreachable: 3 } as const;

export type OptionSpec = { type: "string" | "boolean"; multiple?: boolean; description: string };

export type CommandIo = {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    stdin: NodeJS.ReadableStream;
    env: NodeJS.ProcessEnv;
    cwd: string;
    homeDir: string;
    isStdoutTerminal: boolean;
    isStdinTerminal: boolean;
};

export type CommandInput = {
    positionals: string[];
    options: Record<string, string | boolean | string[] | undefined>;
    json: boolean;
    runtimeDir?: string;
    io: CommandIo;
};

export type CommandSpec = {
    group?: string;
    verb: string;
    summary: string;
    positionals: { name: string; required: boolean; variadic?: boolean }[];
    options: Record<string, OptionSpec>;
    isData: boolean;
    callsService: boolean;
    run(input: CommandInput): Promise<number>;
};

export type ParsedCommandLine =
    | { kind: "help"; usage: string }
    | { kind: "usage-error"; message: string; usage: string }
    | { kind: "reserved-group"; group: string; message: string }
    | { kind: "command"; command: CommandSpec; input: Omit<CommandInput, "io"> };

const HELP_OPTION: OptionSpec = { type: "boolean", description: "Print this usage." };
const JSON_OPTION: OptionSpec = { type: "boolean", description: "Print the service's answer as JSON." };
const RUNTIME_DIR_OPTION: OptionSpec = {
    type: "string",
    description: "The directory of the daemon's socket.",
};

function commandName(command: CommandSpec): string {
    return command.group === undefined ? command.verb : `${command.group} ${command.verb}`;
}

function optionsOf(command: CommandSpec): Record<string, OptionSpec> {
    return {
        ...command.options,
        ...(command.isData ? { json: JSON_OPTION } : {}),
        ...(command.callsService ? { "runtime-dir": RUNTIME_DIR_OPTION } : {}),
        help: HELP_OPTION,
    };
}

function positionalUsage(command: CommandSpec): string {
    return command.positionals
        .map(({ name, required, variadic }) => {
            const label = variadic ? `${name}...` : name;
            return required ? `<${label}>` : `[${label}]`;
        })
        .map((label) => ` ${label}`)
        .join("");
}

function pad(label: string): string {
    return `  ${label.padEnd(22)}`;
}

function commandUsage(command: CommandSpec): string {
    const lines = [`Usage: bob ${commandName(command)}${positionalUsage(command)} [options]`, "", command.summary, ""];
    lines.push("Options:");
    for (const [name, spec] of Object.entries(optionsOf(command))) {
        const label = spec.type === "string" ? `--${name} <value>` : `--${name}`;
        lines.push(`${pad(label)}${spec.description}`);
    }
    return `${lines.join("\n")}\n`;
}

function groupUsage(group: string, commands: readonly CommandSpec[]): string {
    const lines = [`Usage: bob ${group} <command> [options]`, "", "Commands:"];
    for (const command of commands.filter((candidate) => candidate.group === group)) {
        lines.push(`${pad(command.verb)}${command.summary}`);
    }
    lines.push("", `Run "bob ${group} <command> --help" for the usage of one command.`);
    return `${lines.join("\n")}\n`;
}

function visibleGroups(commands: readonly CommandSpec[]): string[] {
    const groups = commands.flatMap((command) => (command.group === undefined ? [] : [command.group]));
    return [...new Set(groups)].filter((group) => !RESERVED_GROUPS.includes(group));
}

function topLevelUsage(commands: readonly CommandSpec[]): string {
    const lines = ["Usage: bob <command> [options]", "", "Commands:"];
    for (const command of commands.filter((candidate) => candidate.group === undefined)) {
        lines.push(`${pad(command.verb)}${command.summary}`);
    }
    for (const group of visibleGroups(commands)) {
        lines.push(`${pad(`${group} <command>`)}Run "bob ${group} --help" for its commands.`);
    }
    lines.push("", 'Run "bob <command> --help" for the usage of one command.');
    return `${lines.join("\n")}\n`;
}

function leadingWords(argv: readonly string[]): { words: string[]; rest: string[] } {
    const firstOption = argv.findIndex((argument) => argument.startsWith("-"));
    const split = firstOption === -1 ? argv.length : firstOption;
    return { words: argv.slice(0, split), rest: argv.slice(split) };
}

function usageError(message: string, usage: string): ParsedCommandLine {
    return { kind: "usage-error", message, usage };
}

function parseCommandArguments(command: CommandSpec, args: readonly string[], usage: string): ParsedCommandLine {
    let parsed: ReturnType<typeof parseArgs>;
    try {
        parsed = parseArgs({ args: [...args], options: optionsOf(command), strict: true, allowPositionals: true });
    } catch (error) {
        return usageError(error instanceof Error ? error.message : String(error), usage);
    }
    const { help, json, "runtime-dir": runtimeDir, ...options } = parsed.values;
    if (help === true) {
        return { kind: "help", usage: commandUsage(command) };
    }
    const positionals = parsed.positionals;
    const required = command.positionals.filter((positional) => positional.required);
    if (positionals.length < required.length) {
        return usageError(`Missing argument <${required[positionals.length]?.name}>.`, usage);
    }
    const isVariadic = command.positionals.some((positional) => positional.variadic === true);
    if (!isVariadic && positionals.length > command.positionals.length) {
        return usageError(`Unexpected argument "${positionals[command.positionals.length]}".`, usage);
    }
    return {
        kind: "command",
        command,
        input: {
            positionals,
            options: options as CommandInput["options"],
            json: json === true,
            ...(typeof runtimeDir === "string" ? { runtimeDir } : {}),
        },
    };
}

export function parseCommandLine(argv: readonly string[], commands: readonly CommandSpec[]): ParsedCommandLine {
    const { words, rest } = leadingWords(argv);
    const isHelp = rest.includes("--help");
    const [first, second] = words;
    if (first === undefined) {
        return isHelp
            ? { kind: "help", usage: topLevelUsage(commands) }
            : usageError("Missing command.", topLevelUsage(commands));
    }
    if (RESERVED_GROUPS.includes(first)) {
        return { kind: "reserved-group", group: first, message: `The ${first} group isn't available yet.` };
    }
    const topLevel = commands.find((command) => command.group === undefined && command.verb === first);
    if (topLevel !== undefined) {
        return parseCommandArguments(topLevel, [...words.slice(1), ...rest], commandUsage(topLevel));
    }
    if (!visibleGroups(commands).includes(first)) {
        return usageError(`Unknown command "${first}".`, topLevelUsage(commands));
    }
    const usage = groupUsage(first, commands);
    if (second === undefined) {
        return isHelp ? { kind: "help", usage } : usageError(`Missing command for "${first}".`, usage);
    }
    const command = commands.find((candidate) => candidate.group === first && candidate.verb === second);
    if (command === undefined) {
        return usageError(`Unknown command "${first} ${second}".`, usage);
    }
    return parseCommandArguments(command, [...words.slice(2), ...rest], usage);
}
