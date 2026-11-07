/**
 * The tab's side of the shared worker (ADR-007): it connects to the worker, relays the worker's messages to the
 * page's listeners, and gives the one client every page calls through. It reloads the tab when the service it
 * reconnects to has another version (decision 9).
 */
import { browserTransport } from "./client/browser_transport.ts";
import { type Client, ClientError, createClient, UnreachableError } from "./client/client.ts";
import type { TabMessage, WorkerMessage } from "./feed_hub.ts";

/** What the worker tells a tab other than the connection state. */
export type FeedEvent = Exclude<WorkerMessage, { type: "connection" }>;

export type FeedConnection = {
    /** Asks the worker for these conversations' streams; the call replaces the tab's earlier set. */
    follow(conversationIds: readonly string[]): void;
    onEvent(listener: (event: FeedEvent) => void): void;
    /** The listener hears the current state at once when the worker has told it, and each change after. */
    onConnection(listener: (isConnected: boolean) => void): void;
    /** Fires on each new instance snapshot, after a restart or a `lagging` end, so a page reads its records again. */
    onInstanceSnapshot(listener: (snapshot: unknown) => void): void;
};

const WORKER_URL = "./feed_worker.ts";
const PROBE_MS = 1000;

let workerPort: MessagePort | undefined;
let sharedClient: Client | undefined;
let onOwnCallFailed: (() => void) | undefined;

const tellWorker = (message: TabMessage) => workerPort?.postMessage(message);

const isUnreachableOrUnavailable = (error: unknown): boolean =>
    error instanceof UnreachableError || (error instanceof ClientError && error.code === "unavailable");

/** The client every page uses. A call that fails as unreachable or `unavailable` is told to the worker, then rethrown. */
export function pageClient(): Client {
    if (sharedClient === undefined) {
        const client = createClient(browserTransport(location.origin));
        sharedClient = {
            ...client,
            async invoke(name, input) {
                try {
                    return await client.invoke(name, input);
                } catch (error) {
                    if (isUnreachableOrUnavailable(error)) {
                        tellWorker({ type: "call-failed" });
                        onOwnCallFailed?.();
                    }
                    throw error;
                }
            },
        };
    }
    return sharedClient;
}

const internVersion = async (): Promise<string> =>
    ((await pageClient().invoke("daemon.status")) as { versions: { intern: string } }).versions.intern;

/** Reloads the tab when the service now runs another version than the one that served this page. */
async function reloadOnNewVersion(loadedVersion: string): Promise<void> {
    try {
        if ((await internVersion()) !== loadedVersion) location.reload();
    } catch {
        // The service went away again; the next reconnect checks again.
    }
}

/** Connects to the shared worker, loaded with the service's version in its address, and asks it for instance events. */
export async function connectFeed(): Promise<FeedConnection> {
    const loadedVersion = await internVersion();
    const worker = new SharedWorker(`${WORKER_URL}?v=${encodeURIComponent(loadedVersion)}`, { type: "module" });
    const port = worker.port;
    const probeClient = createClient(browserTransport(location.origin));
    workerPort = port;

    const eventListeners: ((event: FeedEvent) => void)[] = [];
    const connectionListeners: ((isConnected: boolean) => void)[] = [];
    const snapshotListeners: ((snapshot: unknown) => void)[] = [];
    let followed: readonly string[] = [];
    let isConnected: boolean | undefined;

    // The tab's own state: the worker's word, or at once a failure of the tab's own call (see `probeUntilAnswered`).
    const setConnected = (value: boolean) => {
        if (isConnected === value) return;
        const isReturn = isConnected === false && value;
        isConnected = value;
        for (const listener of connectionListeners) listener(value);
        if (isReturn) void reloadOnNewVersion(loadedVersion);
    };
    let isProbing = false;
    // The worker says nothing when its check finds the service healthy, so a tab that showed the banner for its own
    // failed call asks the service itself until it answers.
    const probeUntilAnswered = async () => {
        if (isProbing) return;
        isProbing = true;
        while (isConnected === false) {
            await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
            try {
                const status = (await probeClient.invoke("daemon.status")) as { phase?: string };
                if (status.phase !== "stopping") setConnected(true);
            } catch {
                // Still unreachable or unavailable: ask again.
            }
        }
        isProbing = false;
    };
    onOwnCallFailed = () => {
        setConnected(false);
        void probeUntilAnswered();
    };

    port.onmessage = (message: MessageEvent<WorkerMessage>) => {
        const data = message.data;
        if (data.type === "connection") {
            setConnected(data.isConnected);
            return;
        }
        for (const listener of eventListeners) listener(data);
        if (data.type === "instance-snapshot") for (const listener of snapshotListeners) listener(data.snapshot);
    };

    const follow = (conversationIds: readonly string[]) => {
        followed = conversationIds;
        tellWorker({ type: "follow", conversationIds });
    };
    window.addEventListener("pagehide", () => tellWorker({ type: "leaving" }));
    window.addEventListener("pageshow", () => follow(followed));
    tellWorker({ type: "instance" });

    return {
        follow,
        onEvent: (listener) => void eventListeners.push(listener),
        onConnection(listener) {
            connectionListeners.push(listener);
            if (isConnected !== undefined) listener(isConnected);
        },
        onInstanceSnapshot: (listener) => void snapshotListeners.push(listener),
    };
}
