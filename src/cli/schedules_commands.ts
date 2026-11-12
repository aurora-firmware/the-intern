/**
 * The `bob schedules` group (S-007 REQ-011): each command calls the schedule operations of S-007 with the arguments
 * given and prints the answer. The service validates every value, so a refusal is printed as the service gives it.
 * Imports no daemon code.
 */
import type { Client } from "../client/client.ts";
import type { ScheduleRunItem } from "../jobs/job_store.ts";
import type { CommandInput, CommandSpec, OptionSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeJson, writeLine } from "./output.ts";
import { entriesText, entryText, type ScheduleEntryView } from "./schedule_text.ts";

type ScheduleAnswer = { schedule: ScheduleEntryView };
type RunsAnswer = { items: readonly ScheduleRunItem[] };

const namePositional = { name: "name", required: true };

const ENTRY_OPTIONS: Record<string, OptionSpec> = {
    cron: { type: "string", description: "The cron expression that says when the entry fires." },
    request: { type: "string", description: "The request of each scheduled run." },
    role: { type: "string", description: "The role of the run's lead." },
    model: { type: "string", description: "The model of the run's lead." },
    "thinking-level": { type: "string", description: "The thinking level of the run's lead." },
    workspace: { type: "string", description: "The workspace of the run." },
};

// The option behind each input of the operations; an option the team member left out is left out of the input.
const INPUT_OF_OPTION = {
    cron: "cron",
    request: "request",
    role: "role",
    model: "model",
    "thinking-level": "thinkingLevel",
    workspace: "workspace",
} as const;

function entryFieldsOf({ options }: CommandInput): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [option, field] of Object.entries(INPUT_OF_OPTION)) {
        const value = options[option];
        if (typeof value === "string") fields[field] = value;
    }
    return fields;
}

function scheduleCommand(
    spec: Pick<CommandSpec, "verb" | "summary" | "positionals"> & { options?: Record<string, OptionSpec> },
    action: (client: Client, input: CommandInput) => Promise<number>,
): CommandSpec {
    return {
        group: "schedules",
        options: {},
        ...spec,
        isData: true,
        callsService: true,
        run: (input) => withClient(input, (client) => action(client, input)),
    };
}

// Prints the answer as JSON, or the one line of text for a command whose answer carries nothing to show.
function printAnswer(input: CommandInput, answer: unknown, text: string): number {
    if (input.json) writeJson(input.io, answer);
    else writeLine(input.io, text);
    return EXIT_CODES.ok;
}

const schedulesList = scheduleCommand(
    { verb: "list", summary: "List schedule entries.", positionals: [] },
    async (client, input) => {
        const answer = (await client.invoke("schedules.list", {})) as { schedules: ScheduleEntryView[] };
        if (input.json) writeJson(input.io, answer);
        else if (answer.schedules.length > 0) writeLine(input.io, entriesText(answer));
        return EXIT_CODES.ok;
    },
);

const schedulesShow = scheduleCommand(
    { verb: "show", summary: "Show one entry and its recent runs.", positionals: [namePositional] },
    async (client, input) => {
        const [name] = input.positionals;
        const entry = (await client.invoke("schedules.get", { name })) as ScheduleAnswer;
        const runs = (await client.invoke("schedules.runs", { name })) as RunsAnswer;
        if (input.json) writeJson(input.io, { "schedules.get": entry, "schedules.runs": runs });
        else writeLine(input.io, entryText(entry, runs));
        return EXIT_CODES.ok;
    },
);

const schedulesCreate = scheduleCommand(
    { verb: "create", summary: "Create a schedule entry.", positionals: [namePositional], options: ENTRY_OPTIONS },
    async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke("schedules.create", { name, ...entryFieldsOf(input) });
        return printAnswer(input, answer, `${name} created`);
    },
);

const schedulesChange = scheduleCommand(
    { verb: "change", summary: "Change a schedule entry.", positionals: [namePositional], options: ENTRY_OPTIONS },
    async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke("schedules.change", { name, ...entryFieldsOf(input) });
        return printAnswer(input, answer, `${name} changed`);
    },
);

const schedulesRemove = scheduleCommand(
    { verb: "remove", summary: "Remove a schedule entry.", positionals: [namePositional] },
    async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke("schedules.remove", { name });
        return printAnswer(input, answer, `${name} removed`);
    },
);

const schedulesRun = scheduleCommand(
    { verb: "run", summary: "Start a scheduled run of an entry now.", positionals: [namePositional] },
    async (client, input) => {
        const [name] = input.positionals;
        const job = (await client.invoke("schedules.run", { name })) as { number: string };
        return printAnswer(input, job, `${name} started as ${job.number}`);
    },
);

export const SCHEDULES_COMMANDS: readonly CommandSpec[] = [
    schedulesList,
    schedulesShow,
    schedulesCreate,
    schedulesChange,
    schedulesRemove,
    schedulesRun,
];
