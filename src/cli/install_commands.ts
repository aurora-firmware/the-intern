/**
 * The `bob service` group (S-010 REQ-004, REQ-005): the installation commands. They call no operation of the service,
 * and the table imports nothing from `src/install/`: each `run` loads its steps when it runs (ADR-005 decision 2).
 */
import type { CommandInput, CommandSpec } from "./command_line.ts";

/** The resumers of cut-off operations. The upgrade and rollback commands add theirs; none exists yet. */
const RESUMERS = {
    upgrade: async () => {},
    "switch-back": async () => {},
    "fresh-start": async () => {},
    rollback: async () => {},
};

async function contextOf(input: CommandInput) {
    const { serviceCommandContext } = await import("../install/service_commands.ts");
    return serviceCommandContext(input.io, RESUMERS);
}

const install: CommandSpec = {
    group: "service",
    verb: "install",
    summary: "Register the service and start it at boot, then wait until it is ready.",
    positionals: [],
    options: {},
    isData: false,
    callsService: false,
    async run(input) {
        const { runServiceInstall } = await import("../install/service_commands.ts");
        return runServiceInstall(await contextOf(input));
    },
};

const remove: CommandSpec = {
    group: "service",
    verb: "remove",
    summary: "Stop the service and remove its registration. The program and the data stay.",
    positionals: [],
    options: {},
    isData: false,
    callsService: false,
    async run(input) {
        const { runServiceRemove } = await import("../install/service_commands.ts");
        return runServiceRemove(await contextOf(input));
    },
};

const status: CommandSpec = {
    group: "service",
    verb: "status",
    summary: "Show whether the service is registered, starts at boot and runs, and the directories it uses.",
    positionals: [],
    options: { json: { type: "boolean", description: "Print the status as one JSON object." } },
    isData: false,
    callsService: false,
    async run(input) {
        const { runServiceStatus } = await import("../install/service_commands.ts");
        return runServiceStatus(await contextOf(input), { json: input.json });
    },
};

export const INSTALL_COMMANDS: readonly CommandSpec[] = [install, remove, status];
