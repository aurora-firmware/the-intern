/**
 * How a `bob` command reaches the daemon (S-005 REQ-002, REQ-003): the socket in the runtime directory, the client
 * over it, and the mapping of its failures to exit codes. Imports the client library and the path layout only, never
 * the daemon.
 */
import { type Client, ClientError, createClient, UnreachableError } from "../client/client.ts";
import { nodeTransport } from "../client/node_transport.ts";
import { InstanceDirError, localSocketPath, resolveInstanceDirs } from "../daemon/state_layout.ts";
import { type CommandInput, EXIT_CODES } from "./command_line.ts";
import { writeError } from "./output.ts";
import { flat } from "./terminal_text.ts";

export function UNREACHABLE_MESSAGE(path: string): string {
    return `The Intern isn't running here (${path}); start it with \`bob serve\``;
}

/** The runtime directory: the flag, else `BOB_RUNTIME_DIR`, else the default of S-002 REQ-006. */
export function resolveRuntimeDir(input: { flag?: string; env: NodeJS.ProcessEnv; homeDir: string }): string {
    const { flag, env, homeDir } = input;
    const named = flag ?? (env.BOB_RUNTIME_DIR ? env.BOB_RUNTIME_DIR : undefined);
    return resolveInstanceDirs({ flags: { runtimeDir: named }, env, homeDir }).runtimeDir;
}

export function socketPathFor(input: CommandInput): string {
    const { io, runtimeDir } = input;
    return localSocketPath(resolveRuntimeDir({ flag: runtimeDir, env: io.env, homeDir: io.homeDir }));
}

/** Runs the action with a client on the daemon's socket and returns its exit code, or the code of the failure. */
export async function withClient(input: CommandInput, action: (client: Client) => Promise<number>): Promise<number> {
    const { io } = input;
    let socketPath: string;
    try {
        socketPath = socketPathFor(input);
    } catch (error) {
        if (!(error instanceof InstanceDirError)) throw error;
        writeError(io, error.message);
        return EXIT_CODES.usage;
    }
    try {
        return await action(createClient(nodeTransport({ socketPath })));
    } catch (error) {
        if (error instanceof UnreachableError) {
            writeError(io, UNREACHABLE_MESSAGE(socketPath));
            return EXIT_CODES.unreachable;
        }
        if (error instanceof ClientError) {
            writeError(io, `${flat(error.code)}: ${flat(error.message)}`);
            return EXIT_CODES.refused;
        }
        throw error;
    }
}
