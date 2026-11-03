/**
 * The instance commands `bob status` and `bob usage` (S-005 REQ-008): they print what `daemon.status` and `usage.get`
 * answer. Imports no daemon code.
 */
import type { UsageReport, UsageTotals } from "../host/host_inspection.ts";
import type { ConversationListing } from "../service/conversation_read_operations.ts";
import type { DaemonStatus } from "../service/status_operation.ts";
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeJson, writeLine } from "./output.ts";

function statusLines(status: DaemonStatus): string[] {
    const { instance, versions, workerThreads } = status;
    return [
        `Phase: ${status.phase}`,
        `Started: ${status.startedAt}`,
        `The Intern: ${versions.intern}`,
        `pi: ${versions.pi}`,
        `Config directory: ${instance.configDir}`,
        `State directory: ${instance.stateDir}`,
        `Data directory: ${instance.dataDir}`,
        `Runtime directory: ${instance.runtimeDir}`,
        `Worker threads: ${workerThreads.count}`,
        `Worker threads in use: ${workerThreads.inUse}`,
        `Worker threads waiting: ${workerThreads.waiting.length}`,
    ];
}

function usageLines(heading: string, report: UsageReport): string[] {
    const lines = [heading];
    const buckets: [string, Record<string, UsageTotals>][] = [
        ["model", report.models],
        ["tool", report.tools],
    ];
    for (const [kind, bucket] of buckets) {
        for (const [name, totals] of Object.entries(bucket)) {
            lines.push(
                `  ${kind} ${name}: ${totals.input} in, ${totals.output} out, ${totals.totalTokens} tokens, cost ${totals.cost.total}`,
            );
        }
    }
    if (lines.length === 1) lines.push("  no usage yet");
    return lines;
}

export const statusCommand: CommandSpec = {
    verb: "status",
    summary: "Print the daemon's status.",
    positionals: [],
    options: {},
    isData: true,
    callsService: true,
    run: (input: CommandInput) =>
        withClient(input, async (client) => {
            const status = (await client.invoke("daemon.status", {})) as DaemonStatus;
            if (input.json) writeJson(input.io, status);
            else for (const line of statusLines(status)) writeLine(input.io, line);
            return EXIT_CODES.ok;
        }),
};

export const usageCommand: CommandSpec = {
    verb: "usage",
    summary: "Print the usage per conversation and in total.",
    positionals: [],
    options: {},
    isData: true,
    callsService: true,
    run: (input: CommandInput) =>
        withClient(input, async (client) => {
            const total = (await client.invoke("usage.get", {})) as UsageReport;
            if (input.json) {
                writeJson(input.io, total);
                return EXIT_CODES.ok;
            }
            const conversations = (await client.invoke("conversations.list", {})) as ConversationListing[];
            for (const { id } of conversations) {
                const report = (await client.invoke("usage.get", { conversationId: id })) as UsageReport;
                for (const line of usageLines(`Conversation ${id}`, report)) writeLine(input.io, line);
            }
            for (const line of usageLines("Total", total)) writeLine(input.io, line);
            return EXIT_CODES.ok;
        }),
};
