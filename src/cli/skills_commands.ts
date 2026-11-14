/**
 * The `bob skills` group (S-008 REQ-012): each command calls the skills operations of S-008 with the arguments given
 * and prints the answer. Where both flags are offered, exactly one of `--role` or `--conversation` names the target;
 * the service validates every other value, so a refusal is printed as the service gives it. Imports no daemon code.
 */
import type { Client } from "../client/client.ts";
import type { CommandInput, CommandSpec, OptionSpec } from "./command_line.ts";
import { commandUsage, EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import {
    type SearchPathView,
    type SkillListView,
    type SkillView,
    searchPathsText,
    skillListText,
    skillText,
} from "./skill_text.ts";

const nameArgument = { name: "name", required: true };
const pathArgument = { name: "path", required: true };

const TARGET_OPTIONS: Record<string, OptionSpec> = {
    role: { type: "string", description: "The role whose skills to use." },
    conversation: { type: "string", description: "The conversation whose agent's skills to use." },
};

type SkillsSpec = Pick<CommandSpec, "verb" | "summary" | "positionals"> & { options?: Record<string, OptionSpec> };

function skillsCommand(
    spec: SkillsSpec,
    action: (client: Client, input: CommandInput) => Promise<number>,
    precheck?: (input: CommandInput) => number | undefined,
): CommandSpec {
    const command: CommandSpec = {
        group: "skills",
        options: {},
        ...spec,
        isData: true,
        callsService: true,
        run: (input) => {
            const refused = precheck?.(input);
            if (refused !== undefined) {
                writeError(input.io, `Give exactly one of --role or --conversation.\n${commandUsage(command)}`);
                return Promise.resolve(refused);
            }
            return withClient(input, (client) => action(client, input));
        },
    };
    return command;
}

// The target of the operation, or undefined when none or both flags were given.
function targetOf({ options }: CommandInput): { role: string } | { conversation: string } | undefined {
    const { role, conversation } = options;
    if (typeof role === "string" && typeof conversation !== "string") return { role };
    if (typeof conversation === "string" && typeof role !== "string") return { conversation };
    return undefined;
}

const needsOneTarget = (input: CommandInput) => (targetOf(input) === undefined ? EXIT_CODES.usage : undefined);

function printText(input: CommandInput, answer: unknown, text: string): number {
    if (input.json) writeJson(input.io, answer);
    else if (text !== "") writeLine(input.io, text);
    return EXIT_CODES.ok;
}

const skillsList = skillsCommand(
    { verb: "list", summary: "List the skills of a role or a conversation.", positionals: [], options: TARGET_OPTIONS },
    async (client, input) => {
        const answer = (await client.invoke("skills.list", targetOf(input))) as SkillListView;
        return printText(input, answer, skillListText(answer));
    },
    needsOneTarget,
);

function changeCommand(verb: "enable" | "disable"): CommandSpec {
    return skillsCommand(
        {
            verb,
            summary: `${verb === "enable" ? "Enable" : "Disable"} a skill for a role or a conversation.`,
            positionals: [nameArgument],
            options: TARGET_OPTIONS,
        },
        async (client, input) => {
            const [name] = input.positionals;
            const answer = (await client.invoke(`skills.${verb}`, { name, ...targetOf(input) })) as {
                enabledSkills: string[];
            };
            return printText(input, answer, `${name} ${verb}d`);
        },
        needsOneTarget,
    );
}

const skillsPaths = skillsCommand(
    { verb: "paths", summary: "List the skill search paths.", positionals: [] },
    async (client, input) => {
        const answer = (await client.invoke("skills.paths.list", {})) as SearchPathView[];
        return printText(input, answer, searchPathsText(answer));
    },
);

function pathCommand(verb: "add-path" | "remove-path"): CommandSpec {
    const operation = verb === "add-path" ? "skills.paths.add" : "skills.paths.remove";
    return skillsCommand(
        {
            verb,
            summary: `${verb === "add-path" ? "Add" : "Remove"} a skill search path.`,
            positionals: [pathArgument],
        },
        async (client, input) => {
            const answer = (await client.invoke(operation, { path: input.positionals[0] })) as SearchPathView[];
            return printText(input, answer, searchPathsText(answer));
        },
    );
}

const skillsRestore = skillsCommand(
    { verb: "restore", summary: "Restore a shipped skill to its installed version.", positionals: [nameArgument] },
    async (client, input) => {
        const answer = (await client.invoke("skills.restore", { name: input.positionals[0] })) as SkillView;
        return printText(input, answer, skillText(answer));
    },
);

export const SKILLS_COMMANDS: readonly CommandSpec[] = [
    skillsList,
    changeCommand("enable"),
    changeCommand("disable"),
    skillsPaths,
    pathCommand("add-path"),
    pathCommand("remove-path"),
    skillsRestore,
];
