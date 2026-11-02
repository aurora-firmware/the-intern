import { join } from "node:path";

export const LOCAL_SOCKET_FILE = "bob.sock";

/** The longest socket path the platform accepts: the size of `sun_path` less its terminating byte. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

export function localSocketPath(runtimeDir: string): string {
    return join(runtimeDir, LOCAL_SOCKET_FILE);
}
