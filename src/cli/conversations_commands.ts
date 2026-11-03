/**
 * The `bob conversations` group (S-005 REQ-011): each command calls the conversation operations of S-002 with the
 * arguments given and prints the answer. The service decides what a conversation accepts, a closed one included, so
 * a refusal is printed as the service gives it. Imports no daemon code.
 */

import { randomUUID } from "node:crypto";
import type { Client } from "../client/client.ts";
import type { ConversationListing, InvocationTree } from "../service/conversation_read_operations.ts";
import type { CommandInput, CommandSpec, OptionSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { formatConversationLine, formatInvocations, formatSeat, formatTranscript } from "./conversation_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";

const ENTRY_PAGE_SIZE = 500;
const NOTHING = "(none)";
const idPositional = { name: "id", required: true };

type EntryPage = { entries: Parameters<typeof formatTranscript>[0][number][]; next?: string };
type SubmitAnswer = { submissionId: string } | { held: true };
type SeatAnswer = Parameters<typeof formatSeat>[0];

const group = "conversations";

function stringOption(input: CommandInput, name: string): string | undefined {
    const value = input.options[name];
    return typeof value === "string" ? value : undefined;
}

function conversationsCommand(
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

// Prints the answer as JSON, or the one line of text for a command whose answer carries nothing to show.
function printAnswer(input: CommandInput, answer: unknown, text: string): number {
    if (input.json) writeJson(input.io, answer);
    else writeLine(input.io, text);
    return EXIT_CODES.ok;
}

const list = conversationsCommand(
    {
        verb: "list",
        summary: "List conversations.",
        positionals: [],
        options: { job: { type: "string", description: "Only the conversations of this job." } },
    },
    async (client, input) => {
        const ref = stringOption(input, "job");
        const filter: Record<string, string> = {};
        if (ref !== undefined) filter.jobId = ((await client.invoke("jobs.get", { job: ref })) as { id: string }).id;
        const listings = (await client.invoke("conversations.list", filter)) as ConversationListing[];
        if (input.json) writeJson(input.io, listings);
        else for (const listing of listings) writeLine(input.io, formatConversationLine(listing));
        return EXIT_CODES.ok;
    },
);

// The service pages entries oldest first, so the latest entries are on the last page.
async function allEntries(client: Client, conversationId: string, first: EntryPage): Promise<EntryPage["entries"]> {
    const entries = [...first.entries];
    let after = first.next;
    while (after !== undefined) {
        const page = (await client.invoke("conversations.entries", {
            conversationId,
            limit: ENTRY_PAGE_SIZE,
            after,
        })) as EntryPage;
        entries.push(...page.entries);
        after = page.next;
    }
    return entries;
}

function invokedLines(tree: InvocationTree): string[] {
    return tree.invoked.length === 0 ? [`  ${NOTHING}`] : formatInvocations(tree).map((line) => `  ${line}`);
}

const show = conversationsCommand(
    { verb: "show", summary: "Show one conversation.", positionals: [idPositional] },
    async (client, input) => {
        const [conversationId] = input.positionals;
        const conversation = (await client.invoke("conversations.get", { conversationId })) as ConversationListing;
        const entries = (await client.invoke("conversations.entries", {
            conversationId,
            limit: ENTRY_PAGE_SIZE,
        })) as EntryPage;
        const invocations = (await client.invoke("conversations.invocations", { conversationId })) as InvocationTree;
        if (input.json) {
            writeJson(input.io, {
                "conversations.get": conversation,
                "conversations.entries": entries,
                "conversations.invocations": invocations,
            });
            return EXIT_CODES.ok;
        }
        writeLine(input.io, formatConversationLine(conversation));
        writeLine(input.io, "Transcript:");
        const transcript = formatTranscript(await allEntries(client, conversationId, entries));
        for (const line of transcript.length === 0 ? [NOTHING] : transcript) writeLine(input.io, `  ${line}`);
        writeLine(input.io, "Invoked conversations:");
        for (const line of invokedLines(invocations)) writeLine(input.io, line);
        return EXIT_CODES.ok;
    },
);

const send = conversationsCommand(
    {
        verb: "send",
        summary: "Send text to a conversation; while it runs the text steers it.",
        positionals: [idPositional, { name: "text", required: true }],
        options: {
            "follow-up": {
                type: "boolean",
                description: "Deliver the text after the current run instead of steering.",
            },
            reject: { type: "boolean", description: "Refuse the text with busy while the conversation runs." },
        },
    },
    async (client, input) => {
        const [conversationId, content] = input.positionals;
        const isFollowUp = input.options["follow-up"] === true;
        const isReject = input.options.reject === true;
        if (isFollowUp && isReject) {
            writeError(input.io, "Give at most one of --follow-up and --reject.");
            return EXIT_CODES.usage;
        }
        const busyMode = isFollowUp ? "followUp" : isReject ? "reject" : "steer";
        const answer = (await client.invoke("conversations.submit", {
            conversationId,
            content,
            requestId: randomUUID(),
            busyMode,
        })) as SubmitAnswer;
        if ("held" in answer) return printAnswer(input, answer, `held for ${conversationId} until it continues`);
        const verb = busyMode === "steer" ? "steered" : "submitted";
        return printAnswer(input, answer, `${verb} to ${conversationId}`);
    },
);

function controlCommand(verb: "stop" | "reset" | "compact", summary: string, done: string): CommandSpec {
    const operation = verb === "stop" ? "abort" : verb;
    const extra: Record<string, OptionSpec> =
        verb === "compact" ? { instructions: { type: "string", description: "What the compaction should keep." } } : {};
    return conversationsCommand(
        { verb, summary, positionals: [idPositional], options: extra },
        async (client, input) => {
            const [conversationId] = input.positionals;
            const instructions = stringOption(input, "instructions");
            const call = instructions === undefined ? { conversationId } : { conversationId, instructions };
            const answer = await client.invoke(`conversations.${operation}`, call);
            return printAnswer(input, answer, `${done} ${conversationId}`);
        },
    );
}

const seat = conversationsCommand(
    {
        verb: "seat",
        summary: "Seat a conversation in a role, with optional overrides.",
        positionals: [idPositional],
        options: {
            role: { type: "string", description: "The role to seat the conversation in." },
            model: { type: "string", description: "A model, instead of the role's." },
            thinking: { type: "string", description: "A thinking level, instead of the role's." },
            workspace: { type: "string", description: "A registered workspace, instead of the role's." },
            reset: { type: "boolean", description: "Reset the conversation to the Clean mode with the new seat." },
            note: { type: "string", description: "The note of the reset; needs --reset." },
        },
    },
    async (client, input) => {
        const [conversationId] = input.positionals;
        const role = stringOption(input, "role");
        const note = stringOption(input, "note");
        const isReset = input.options.reset === true;
        if (role === undefined || (note !== undefined && !isReset)) {
            writeError(input.io, role === undefined ? "Give --role." : "--note needs --reset.");
            return EXIT_CODES.usage;
        }
        const overrides = { model: stringOption(input, "model"), thinkingLevel: stringOption(input, "thinking") };
        const call: Record<string, unknown> = { conversationId, role, workspace: stringOption(input, "workspace") };
        Object.assign(call, overrides);
        for (const [field, value] of Object.entries(call)) if (value === undefined) delete call[field];
        if (isReset) call.reset = note === undefined ? {} : { note };
        const seated = (await client.invoke("conversations.seat", call)) as SeatAnswer;
        return printAnswer(input, seated, `${conversationId} seated as ${formatSeat(seated)}`);
    },
);

export const CONVERSATIONS_COMMANDS: readonly CommandSpec[] = [
    list,
    show,
    send,
    controlCommand("stop", "Abort a conversation's current run.", "stopped"),
    controlCommand("reset", "Reset a conversation to an empty context.", "reset"),
    seat,
    controlCommand("compact", "Compact a conversation's context.", "compacted"),
];
