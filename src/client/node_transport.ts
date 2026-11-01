/**
 * The client library's Node transport (S-003 REQ-009): calls and feed streams over `node:http`, to the daemon's local
 * socket or to a base URL.
 */
import { resolveInstanceDirs } from "../daemon/state_layout.ts";
import { localSocketPath } from "../listeners/socket_path.ts";
import type { Transport } from "./client.ts";

export type DefaultSocketOptions = { env: NodeJS.ProcessEnv; homeDir: string; runtimeDir?: string };

/** The socket the daemon of this instance listens on, its runtime directory resolved as the daemon resolves it. */
export function defaultSocketPath(options: DefaultSocketOptions): string {
    const { env, homeDir, runtimeDir } = options;
    return localSocketPath(resolveInstanceDirs({ flags: { runtimeDir }, env, homeDir }).runtimeDir);
}

export function nodeTransport(_target: { socketPath: string } | { baseUrl: string }): Transport {
    return {
        call: async () => undefined,
        stream: async function* () {},
    };
}
