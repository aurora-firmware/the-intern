/**
 * What the `bob mail` command files share (S-009 REQ-017): the name positional, the shape of a command that calls the
 * service through a client, and the printing of an answer as JSON or text. Imports no daemon code.
 */
import type { Client } from "../client/client.ts";
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeJson, writeLine } from "./output.ts";

export const namePositional = { name: "name", required: true };

export function mailCommand(
    spec: Pick<CommandSpec, "verb" | "summary" | "positionals" | "options">,
    action: (client: Client, input: CommandInput) => Promise<number>,
): CommandSpec {
    return {
        group: "mail",
        ...spec,
        isData: true,
        callsService: true,
        run: (input) => withClient(input, (client) => action(client, input)),
    };
}

// Prints the answer as JSON, or the text of it.
export function printAnswer(input: CommandInput, answer: unknown, text: string): number {
    if (input.json) writeJson(input.io, answer);
    else writeLine(input.io, text);
    return EXIT_CODES.ok;
}
