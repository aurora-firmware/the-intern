/**
 * The body of `bob serve` (S-002 REQ-004 to REQ-006, REQ-021): the daemon in the foreground. Log lines go to standard
 * error, standard output stays unused, and the process exits with the status the daemon settles with. Only the command
 * table's `serve` loads this module, so the other commands never load the daemon's code.
 */
import { homedir } from "node:os";
import { createAgentsComponent } from "../agents/agents_component.ts";
import { runDaemon } from "../daemon/daemon.ts";
import { createLogger, type Logger } from "../daemon/logger.ts";
import { createDeskComponent } from "../desk/desk_component.ts";
import { createJobsComponent } from "../jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../listeners/network_listener.ts";
import { networkSection } from "../listeners/network_section.ts";

const FAILURE_EXIT_STATUS = 1;
const KEEP_ALIVE_INTERVAL_MS = 60_000;

export type ServeFlags = {
    "config-dir"?: string;
    "state-dir"?: string;
    "data-dir"?: string;
    "runtime-dir"?: string;
    verbose?: boolean;
};

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

/** Runs the daemon until it exits and returns its exit status. */
export async function runServe(flags: ServeFlags): Promise<number> {
    const logger = createLogger({ verbose: flags.verbose ?? false });
    exitOnUncaughtFailure(logger);
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger });
    const desk = await createDeskComponent({ agents, jobs, logger });
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
        sections: [...agents.sections, networkSection],
        // The listeners follow the agents component, so they open once the agents are ready (S-003 REQ-001).
        components: [
            agents.component,
            jobs.component,
            desk.component,
            createLocalSocketComponent(),
            createNetworkListenerComponent(),
        ],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations],
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
