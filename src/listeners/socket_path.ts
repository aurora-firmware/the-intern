export { LOCAL_SOCKET_FILE, localSocketPath } from "../daemon/state_layout.ts";

/** The longest socket path the platform accepts: the size of `sun_path` less its terminating byte. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;
