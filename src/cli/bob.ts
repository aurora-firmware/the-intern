/**
 * The `bob` command line (S-002 REQ-004 to REQ-006, REQ-021). `bob serve` runs the daemon in the foreground: log lines
 * go to standard error, standard output stays unused, and the process exits with the status the daemon settles with.
 * Run it as `node src/cli/bob.ts serve` until the release form provides a `bob` launcher.
 */
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { createAgentsComponent } from "../agents/agents_component.ts";
import { runDaemon } from "../daemon/daemon.ts";
import { createLogger, type Logger } from "../daemon/logger.ts";
import { createLocalSocketComponent } from "../listeners/local_socket.ts";

const USAGE_EXIT_STATUS = 2;
const FAILURE_EXIT_STATUS = 1;
const KEEP_ALIVE_INTERVAL_MS = 60_000;
const USAGE = `Usage: bob serve [--config-dir <dir>] [--state-dir <dir>] [--data-dir <dir>] [--runtime-dir <dir>] [--verbose]
`;

const SERVE_OPTIONS = {
    "config-dir": { type: "string" },
    "state-dir": { type: "string" },
    "data-dir": { type: "string" },
    "runtime-dir": { type: "string" },
    verbose: { type: "boolean" },
} as const;

function failWithUsage(): number {
    process.stderr.write(USAGE);
    return USAGE_EXIT_STATUS;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function exitOnUncaughtFailure(logger: Logger): void {
    const fail = (description: string) => (error: unknown) => {
        logger.error(description, { cause: describeError(error) });
        process.exit(FAILURE_EXIT_STATUS);
    };
    process.on("uncaughtException", fail("uncaught exception"));
    process.on("unhandledRejection", fail("unhandled rejection"));
}

async function serve(args: readonly string[]): Promise<number> {
    let values: ReturnType<typeof parseArgs<{ options: typeof SERVE_OPTIONS; allowPositionals: true }>>;
    try {
        values = parseArgs({ args: [...args], options: SERVE_OPTIONS, allowPositionals: true, strict: true });
    } catch {
        return failWithUsage();
    }
    if (values.positionals.length > 0) return failWithUsage();

    const flags = values.values;
    const logger = createLogger({ verbose: flags.verbose ?? false });
    exitOnUncaughtFailure(logger);
    const agents = await createAgentsComponent({ logger });
    const daemon = runDaemon({
        flags: {
            ...(flags["config-dir"] !== undefined && { configDir: flags["config-dir"] }),
            ...(flags["state-dir"] !== undefined && { stateDir: flags["state-dir"] }),
            ...(flags["data-dir"] !== undefined && { dataDir: flags["data-dir"] }),
            ...(flags["runtime-dir"] !== undefined && { runtimeDir: flags["runtime-dir"] }),
            ...(flags.verbose !== undefined && { verbose: flags.verbose }),
        },
        env: process.env,
        homeDir: homedir(),
        logger,
        sections: agents.sections,
        // The listeners follow the agents component, so they open once the agents are ready (S-003 REQ-001).
        components: [agents.component, createLocalSocketComponent()],
        operations: agents.operations,
    });

    // stop() of a running shutdown waits for it, so a repeated signal needs no handling of its own.
    let isStopping = false;
    const requestStop = () => {
        if (isStopping) return;
        isStopping = true;
        void daemon.stop();
    };
    process.on("SIGTERM", requestStop);
    process.on("SIGINT", requestStop);
    // Nothing else holds the event loop open while the daemon idles, so a timer does until it has exited.
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
    try {
        return await daemon.exited;
    } finally {
        clearInterval(keepAlive);
    }
}

/** Runs the command and returns the process exit status. */
export async function main(argv: readonly string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command !== "serve") return failWithUsage();
    return serve(rest);
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
    // Open handles of a stopped daemon must not keep the process alive past its settled status.
    process.exit();
}
