/**
 * A client for the calls a following command makes once it is running (S-005 REQ-015): a call that finds the daemon
 * gone, or starting or stopping, prints one notice and is made again until the daemon answers, with the same input, so
 * a request id keeps a submitted line admitted exactly once. Imports the client library only, never the daemon.
 */
import { type Client, ClientError, UnreachableError } from "../client/client.ts";
import { DEFAULT_RETRY_DELAY_MS, outageNoticeFor, pause } from "./feed_follower.ts";

export type PatienceOptions = {
    onNotice(text: string): void;
    /** Called when a call that met an outage is answered at last. */
    onRecovered?(): void;
    /** Once aborted, a call that meets an outage again fails with it instead of waiting; the call in flight is not cut. */
    signal?: AbortSignal;
    retryDelayMs?: number;
    /**
     * Fails with the `UnreachableError` while no call has found the daemon there, instead of waiting for one. A command
     * that starts with no daemon ends (S-005 AC-002.2); a daemon that answered, even `unavailable`, is waited for.
     */
    isAbsentFatalAtStart?: boolean;
};

/** Whether the daemon has been there at any call: it answered, or answered that it is starting or stopping. */
type Reached = { value: boolean };

async function untilAnswered<T>(attempt: () => Promise<T>, options: PatienceOptions, reached: Reached): Promise<T> {
    const { onNotice, onRecovered, signal, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options;
    const neverAborted = new AbortController().signal;
    let lastNotice: string | undefined;
    for (;;) {
        try {
            const answer = await attempt();
            reached.value = true;
            if (lastNotice !== undefined) onRecovered?.();
            return answer;
        } catch (error) {
            if (error instanceof ClientError && error.code === "unavailable") reached.value = true;
            const notice = outageNoticeFor(error);
            if (notice === undefined || signal?.aborted) throw error;
            if (options.isAbsentFatalAtStart && !reached.value && error instanceof UnreachableError) throw error;
            if (notice !== lastNotice) onNotice(notice);
            lastNotice = notice;
            await pause(retryDelayMs, signal ?? neverAborted);
        }
    }
}

/**
 * Wraps `invoke` so it waits out an outage; `subscribe` and `subscribeConversations` are the follower's business and
 * are passed through.
 */
export function patientClient(client: Client, options: PatienceOptions): Client {
    const reached: Reached = { value: false };
    return {
        invoke: (name, input) => untilAnswered(() => client.invoke(name, input), options, reached),
        subscribe: (scope) => client.subscribe(scope),
        subscribeConversations: (conversationIds) => client.subscribeConversations(conversationIds),
    };
}
