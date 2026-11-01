/**
 * The local socket listener as a daemon component (S-003 REQ-001, REQ-010): the HTTP front on `<runtimeDir>/bob.sock`,
 * a file only the service account can use. The daemon holds single ownership of the runtime directory by the time
 * this component starts, so a `bob.sock` already there is a leftover and is replaced.
 */
import { chmod, rm } from "node:fs/promises";
import type { DaemonComponent } from "../daemon/daemon.ts";
import { createHttpFront } from "./http_front.ts";
import { type ListenerServer, startListenerServer } from "./listener_server.ts";
import { localSocketPath, MAX_SOCKET_PATH_BYTES } from "./socket_path.ts";

const OWNER_ONLY_FILE_MODE = 0o600;

function assertPathFits(path: string): void {
    const byteLength = Buffer.byteLength(path);
    if (byteLength <= MAX_SOCKET_PATH_BYTES) return;
    throw new Error(
        `The local socket path ${path} is ${byteLength} bytes, longer than the platform limit of ${MAX_SOCKET_PATH_BYTES}; use a shorter runtime directory`,
    );
}

export function createLocalSocketComponent(): DaemonComponent {
    let listener: ListenerServer | undefined;
    let socketPath: string | undefined;
    return {
        name: "local socket",
        async start(ctx) {
            const path = localSocketPath(ctx.dirs.runtimeDir);
            assertPathFits(path);
            await rm(path, { force: true });
            const front = createHttpFront({ catalogue: ctx.catalogue, wayIn: "command line" });
            listener = await startListenerServer(front, { path });
            socketPath = path;
            await chmod(path, OWNER_ONLY_FILE_MODE);
        },
        async stop() {
            const running = listener;
            listener = undefined;
            await running?.stop();
            if (socketPath !== undefined) await rm(socketPath, { force: true });
            socketPath = undefined;
        },
    };
}
