/**
 * The `bob instructions` group (S-008 REQ-012): `list` names the instruction files of a role or a conversation, and
 * `restore` copies the installed common prompt or a shipped role's instructions back. Exactly one of `--role` or
 * `--conversation` names the target of `list`; the service validates every other value, so a refusal is printed as the
 * service gives it. No command prints file text. Imports no daemon code.
 */
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { commandUsage, EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import { type InstructionFileView, instructionListText } from "./skill_text.ts";

function printFiles(input: CommandInput, answer: unknown, files: readonly InstructionFileView[]): number {
    if (input.json) writeJson(input.io, answer);
    else writeLine(input.io, instructionListText({ files }));
    return EXIT_CODES.ok;
}

// The target of the listing, or undefined when none or both flags were given.
function targetOf({ options }: CommandInput): { role: string } | { conversation: string } | undefined {
    const { role, conversation } = options;
    if (typeof role === "string" && typeof conversation !== "string") return { role };
    if (typeof conversation === "string" && typeof role !== "string") return { conversation };
    return undefined;
}

const instructionsList: CommandSpec = {
    group: "instructions",
    verb: "list",
    summary: "List the instruction files of a role or a conversation.",
    positionals: [],
    options: {
        role: { type: "string", description: "The role whose instruction files to list." },
        conversation: { type: "string", description: "The conversation whose agent's instruction files to list." },
    },
    isData: true,
    callsService: true,
    run(input) {
        const target = targetOf(input);
        if (target === undefined) {
            writeError(input.io, `Give exactly one of --role or --conversation.\n${commandUsage(instructionsList)}`);
            return Promise.resolve(EXIT_CODES.usage);
        }
        return withClient(input, async (client) => {
            const answer = (await client.invoke("instructions.list", target)) as { files: InstructionFileView[] };
            return printFiles(input, answer, answer.files);
        });
    },
};

const instructionsRestore: CommandSpec = {
    group: "instructions",
    verb: "restore",
    summary: "Restore the common prompt or a shipped role's instructions to the installed version.",
    positionals: [{ name: "name", required: true }],
    options: {},
    isData: true,
    callsService: true,
    run: (input) =>
        withClient(input, async (client) => {
            const answer = (await client.invoke("instructions.restore", {
                name: input.positionals[0],
            })) as InstructionFileView;
            return printFiles(input, answer, [answer]);
        }),
};

export const INSTRUCTIONS_COMMANDS: readonly CommandSpec[] = [instructionsList, instructionsRestore];
