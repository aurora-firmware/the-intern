/**
 * The shared worker of ADR-007: every tab of a browser connects here, and one feed hub holds the instance feed and
 * the one conversation stream for all of them. A worker gets no import map, so it imports by relative path.
 */

import { browserTransport } from "./client/browser_transport.ts";
import { createClient } from "./client/client.ts";
import { createFeedHub, type TabMessage, type TabPort } from "./feed_hub.ts";

declare const self: SharedWorkerGlobalScope;

const hub = createFeedHub({
    client: createClient(browserTransport(location.origin)),
    setTimer: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
    },
});

self.onconnect = (event) => {
    const port = event.ports[0] as MessagePort & TabPort;
    port.onmessage = (message: MessageEvent<TabMessage>) => hub.receive(port, message.data);
};
