/**
 * The instance commands: `bob status` and `bob usage` (S-005 REQ-008) print what `daemon.status` and `usage.get`
 * answer; `bob export` and `bob import` (S-005 REQ-013) copy the instance's database out and into an instance. Imports
 * no daemon code at load time: `import` loads the import step inside its `run`.
 */
import { resolve } from "node:path";
import type { InstanceDirFlags } from "../daemon/state_layout.ts";
import type { UsageReport, UsageTotals } from "../host/host_inspection.ts";
import type { ConversationListing } from "../service/conversation_read_operations.ts";
import type { DaemonStatus } from "../service/status_operation.ts";
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import { flat } from "./terminal_text.ts";

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
                `  ${kind} ${flat(name)}: ${totals.input} in, ${totals.output} out, ${totals.totalTokens} tokens, cost ${totals.cost.total}`,
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
            const conversations = (await client.invoke("conversations.list", {})) as ConversationListing[];
            const reports = new Map<string, UsageReport>();
            for (const { id } of conversations) {
                reports.set(id, (await client.invoke("usage.get", { conversationId: id })) as UsageReport);
            }
            if (input.json) {
                writeJson(input.io, { total, conversations: Object.fromEntries(reports) });
                return EXIT_CODES.ok;
            }
            for (const [id, report] of reports) {
                for (const line of usageLines(`Conversation ${flat(id)}`, report)) writeLine(input.io, line);
            }
            for (const line of usageLines("Total", total)) writeLine(input.io, line);
            return EXIT_CODES.ok;
        }),
};

type ExportAnswer = { path: string; size: number };

export const exportCommand: CommandSpec = {
    verb: "export",
    summary: "Write a copy of the database to a new file while the daemon runs.",
    positionals: [{ name: "file", required: true }],
    options: {},
    isData: true,
    callsService: true,
    run: (input: CommandInput) =>
        withClient(input, async (client) => {
            const [file = ""] = input.positionals;
            const path = resolve(input.io.cwd, file);
            const answer = (await client.invoke("jobs.export", { path })) as ExportAnswer;
            if (input.json) writeJson(input.io, answer);
            else writeLine(input.io, `Exported ${answer.path} (${answer.size} bytes)`);
            return EXIT_CODES.ok;
        }),
};

const DIRECTORY_OPTION_NAMES = ["config-dir", "state-dir", "data-dir"] as const;

function directoryFlagsOf(input: CommandInput): InstanceDirFlags {
    const { options, runtimeDir } = input;
    const [configDir, stateDir, dataDir] = DIRECTORY_OPTION_NAMES.map((name) => {
        const value = options[name];
        return typeof value === "string" ? value : undefined;
    });
    return { configDir, stateDir, dataDir, runtimeDir };
}

export const importCommand: CommandSpec = {
    verb: "import",
    summary: "Place an exported database file as the database of a stopped instance.",
    positionals: [{ name: "file", required: true }],
    options: {
        "config-dir": { type: "string", description: "The configuration directory." },
        "state-dir": { type: "string", description: "The state directory." },
        "data-dir": { type: "string", description: "The data directory." },
        "runtime-dir": { type: "string", description: "The runtime directory." },
    },
    isData: false,
    callsService: false,
    async run(input) {
        const { io } = input;
        const [{ importDatabase, ImportRefusedError }, { InstanceDirError, resolveInstanceDirs }] = await Promise.all([
            import("../host/database_import.ts"),
            import("../daemon/state_layout.ts"),
        ]);
        try {
            const { stateDir } = resolveInstanceDirs({
                flags: directoryFlagsOf(input),
                env: io.env,
                homeDir: io.homeDir,
            });
            const [file = ""] = input.positionals;
            await importDatabase({ stateDir, file: resolve(io.cwd, file) });
            writeLine(io, `Imported ${resolve(io.cwd, file)} into ${stateDir}`);
            return EXIT_CODES.ok;
        } catch (error) {
            if (error instanceof ImportRefusedError) {
                writeError(io, error.message);
                return EXIT_CODES.refused;
            }
            if (error instanceof InstanceDirError) {
                writeError(io, error.message);
                return EXIT_CODES.usage;
            }
            throw error;
        }
    },
};
