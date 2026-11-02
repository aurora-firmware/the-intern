/**
 * The network listener as a daemon component (S-003 REQ-002, REQ-010): the HTTP front on the `[network]` address and
 * port, started only when the configuration sets that section.
 */
import type { IncomingMessage } from "node:http";
import type { DaemonComponent } from "../daemon/daemon.ts";
import type { ObservedDetails } from "../service/operations.ts";
import { createHttpFront, type Fallback } from "./http_front.ts";
import { type ListenerServer, startListenerServer } from "./listener_server.ts";
import { networkSection } from "./network_section.ts";
import { createStaticFiles, WEB_UI_DIR } from "./static_files.ts";

const ANY_FREE_PORT = 0;

/** The TCP peer's address and port, never a header such as X-Forwarded-For. */
function observePeer(req: IncomingMessage): ObservedDetails {
    return { remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort };
}

export type NetworkListenerComponent = DaemonComponent & {
    /** The address in use; undefined while nothing listens. */
    address(): { host: string; port: number } | undefined;
};

export type NetworkListenerOptions = {
    /** Test-only: listen on a free port instead of the configured one, so parallel tests never collide. */
    freePort?: boolean;
    /** Answers the requests the front has no route for; the web interface files by default. */
    fallback?: Fallback;
};

export function createNetworkListenerComponent(options: NetworkListenerOptions = {}): NetworkListenerComponent {
    let listener: ListenerServer | undefined;
    let inUse: { host: string; port: number } | undefined;
    return {
        name: "network listener",
        async start(ctx) {
            const settings = ctx.config.current(networkSection);
            if (settings === undefined) return;
            const port = options.freePort ? ANY_FREE_PORT : settings.port;
            const front = createHttpFront({
                catalogue: ctx.catalogue,
                wayIn: "web interface",
                observe: observePeer,
                fallback: options.fallback ?? createStaticFiles(WEB_UI_DIR),
            });
            const started = await startListenerServer(front, { host: settings.address, port });
            listener = started;
            if ("path" in started.address) throw new Error("The network listener server did not bind a host and port");
            inUse = started.address;
            ctx.logger.info("network listener listening", { address: inUse.host, port: inUse.port });
        },
        async stop() {
            const running = listener;
            listener = undefined;
            inUse = undefined;
            await running?.stop();
        },
        address: () => inUse,
    };
}
