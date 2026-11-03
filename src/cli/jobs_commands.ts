/**
 * The `bob jobs` group (S-005 REQ-004): each command calls the job operations of S-004 with the arguments given and
 * prints the answer. A job is passed to the service as given; the service resolves it in any letter case. Imports no
 * daemon code.
 */

import type { Client } from "../client/client.ts";
import type { HistoryEntry, Job, WorklogEntry } from "../jobs/job_store.ts";
import type { CommandInput, CommandSpec, OptionSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { formatCreated, formatJobDetail, formatJobLine } from "./job_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";

const ENTRY_PAGE_SIZE = 500;
const FIELD_OPTIONS = {
    title: "The job's title.",
    description: "The job's description.",
    "definition-of-done": "What has to be true for the job to be complete.",
} as const;

type JobPage = { jobs: Job[]; cursor?: string };
type JobPair = { a: Job; b: Job };

const group = "jobs";

function stringOption(input: CommandInput, name: string): string | undefined {
    const value = input.options[name];
    return typeof value === "string" ? value : undefined;
}

// Sets the service field only for an option the team member gave, so an absent option is absent from the call.
function givenFields(input: CommandInput, names: Record<string, string>): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [option, field] of Object.entries(names)) {
        const value = stringOption(input, option);
        if (value !== undefined) fields[field] = value;
    }
    return fields;
}

function stringOptions(descriptions: Record<string, string>): Record<string, OptionSpec> {
    return Object.fromEntries(
        Object.entries(descriptions).map(([name, description]) => [name, { type: "string", description }]),
    );
}

function printJob(input: CommandInput, job: Job): number {
    if (input.json) writeJson(input.io, job);
    else writeLine(input.io, formatJobLine(job));
    return EXIT_CODES.ok;
}

function jobsCommand(
    spec: Pick<CommandSpec, "verb" | "summary" | "positionals"> & { options?: Record<string, OptionSpec> },
    action: (client: Client, input: CommandInput) => Promise<number>,
): CommandSpec {
    return {
        group,
        options: {},
        ...spec,
        isData: true,
        callsService: true,
        run: (input) => withClient(input, (client) => action(client, input)),
    };
}

const create = jobsCommand(
    {
        verb: "create",
        summary: "Create a job from the text of a request.",
        positionals: [{ name: "text", required: true }],
        options: stringOptions({
            title: "The job's title.",
            role: "The role of the job's lead.",
            model: "The model of the job's lead.",
            thinking: "The thinking level of the job's lead.",
            workspace: "The workspace of the job's lead.",
            "stated-by": "Who stated the request.",
        }),
    },
    async (client, input) => {
        const names = { title: "title", role: "role", model: "model", thinking: "thinkingLevel" };
        const fields = givenFields(input, { ...names, workspace: "workspace", "stated-by": "statedBy" });
        const job = (await client.invoke("jobs.create", { text: input.positionals[0], ...fields })) as Job;
        if (input.json) writeJson(input.io, job);
        else writeLine(input.io, formatCreated(job));
        return EXIT_CODES.ok;
    },
);

const list = jobsCommand(
    {
        verb: "list",
        summary: "List jobs, newest first.",
        positionals: [],
        options: stringOptions({
            status: "Only jobs with this status: to_do, in_progress, blocked or done.",
            letter: "Only jobs with this origin letter.",
            related: "Only jobs Related to this job.",
            limit: "The most jobs to list.",
            cursor: "Continue after the cursor an earlier listing printed.",
        }),
    },
    async (client, input) => {
        const filter: Record<string, unknown> = givenFields(input, {
            status: "status",
            letter: "letter",
            related: "relatedTo",
            cursor: "cursor",
        });
        const limit = stringOption(input, "limit");
        if (limit !== undefined) filter.limit = Number(limit);
        const page = (await client.invoke("jobs.list", filter)) as JobPage;
        if (input.json) {
            writeJson(input.io, page);
            return EXIT_CODES.ok;
        }
        for (const job of page.jobs) writeLine(input.io, formatJobLine(job));
        if (page.cursor !== undefined) writeLine(input.io, `More jobs: --cursor ${page.cursor}`);
        return EXIT_CODES.ok;
    },
);

type EntryPage<T> = { entries: T[]; cursor?: string };

// The service pages entries oldest first, so the latest entries are on the last page.
async function allEntries<T>(client: Client, operation: string, first: EntryPage<T>, job: string): Promise<T[]> {
    const entries = [...first.entries];
    let cursor = first.cursor;
    while (cursor !== undefined) {
        const next = (await client.invoke(operation, { job, limit: ENTRY_PAGE_SIZE, cursor })) as EntryPage<T>;
        entries.push(...next.entries);
        cursor = next.cursor;
    }
    return entries;
}

const show = jobsCommand(
    { verb: "show", summary: "Show one job.", positionals: [{ name: "job", required: true }] },
    async (client, input) => {
        const [ref] = input.positionals;
        const page = { job: ref, limit: ENTRY_PAGE_SIZE };
        const job = (await client.invoke("jobs.get", { job: ref })) as Job;
        const worklog = (await client.invoke("jobs.worklog.list", page)) as EntryPage<WorklogEntry>;
        const history = (await client.invoke("jobs.history.list", page)) as EntryPage<HistoryEntry>;
        if (input.json) {
            writeJson(input.io, { "jobs.get": job, "jobs.worklog.list": worklog, "jobs.history.list": history });
            return EXIT_CODES.ok;
        }
        const detail = {
            job,
            worklog: await allEntries(client, "jobs.worklog.list", worklog, ref),
            history: await allEntries(client, "jobs.history.list", history, ref),
        };
        for (const line of formatJobDetail(detail)) writeLine(input.io, line);
        return EXIT_CODES.ok;
    },
);

const update = jobsCommand(
    {
        verb: "update",
        summary: "Change a job's title, description or definition of done.",
        positionals: [{ name: "job", required: true }],
        options: stringOptions(FIELD_OPTIONS),
    },
    async (client, input) => {
        const fields = givenFields(input, {
            title: "title",
            description: "description",
            "definition-of-done": "definitionOfDone",
        });
        if (Object.keys(fields).length === 0) {
            writeError(
                input.io,
                `Give at least one of ${Object.keys(FIELD_OPTIONS)
                    .map((n) => `--${n}`)
                    .join(", ")}.`,
            );
            return EXIT_CODES.usage;
        }
        const job = (await client.invoke("jobs.update", { job: input.positionals[0], ...fields })) as Job;
        return printJob(input, job);
    },
);

function pairCommand(verb: "relate" | "unrelate", summary: string): CommandSpec {
    return jobsCommand(
        {
            verb,
            summary,
            positionals: [
                { name: "job", required: true },
                { name: "other", required: true },
            ],
        },
        async (client, input) => {
            const [job, other] = input.positionals;
            const pair = (await client.invoke(`jobs.${verb}`, { job, other })) as JobPair;
            if (input.json) writeJson(input.io, pair);
            else for (const changed of [pair.a, pair.b]) writeLine(input.io, formatJobLine(changed));
            return EXIT_CODES.ok;
        },
    );
}

function finishCommand(verb: "complete" | "cancel", summary: string): CommandSpec {
    return jobsCommand(
        {
            verb,
            summary,
            positionals: [
                { name: "job", required: true },
                { name: "justification", required: true },
            ],
        },
        async (client, input) => {
            const [job, justification] = input.positionals;
            const finished = (await client.invoke(`jobs.${verb}`, { job, justification })) as Job;
            return printJob(input, finished);
        },
    );
}

export const JOBS_COMMANDS: readonly CommandSpec[] = [
    create,
    list,
    show,
    update,
    pairCommand("relate", "Relate two jobs."),
    pairCommand("unrelate", "Remove the relation between two jobs."),
    finishCommand("complete", "Complete an In-progress job, with a justification."),
    finishCommand("cancel", "Cancel a job, with a justification."),
];
