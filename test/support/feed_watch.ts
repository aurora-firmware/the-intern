/**
 * A test's own subscriber to the instance feed of a daemon's network listener: it reads `GET /feed?scope=instance`
 * event by event and notes the moment each delta was read, so a browser test can measure from the feed event to a page.
 */
const LOOPBACK = "127.0.0.1";
const EVENT_WAIT_MS = 20_000;

export type FeedDelta = { type: string; number?: string; seq: number };

export type FeedWatch = {
    /** Resolves with the first delta read from now on that the predicate accepts, and the time it was read. */
    nextDelta(accepts: (delta: FeedDelta) => boolean): Promise<{ delta: FeedDelta; readAt: number }>;
    close(): void;
};

type Waiter = { accepts: (delta: FeedDelta) => boolean; resolve(read: { delta: FeedDelta; readAt: number }): void };

function deltaOf(block: string): FeedDelta | undefined {
    const lines = block.split("\n");
    if (!lines.includes("event: delta")) return undefined;
    const data = lines.find((line) => line.startsWith("data: "));
    return data === undefined ? undefined : (JSON.parse(data.slice("data: ".length)) as FeedDelta);
}

/** Opens the feed and resolves once the daemon has answered, so no later change can be missed. */
export async function watchFeed(port: number): Promise<FeedWatch> {
    const controller = new AbortController();
    const response = await fetch(`http://${LOOPBACK}:${port}/feed?scope=instance`, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`The feed was refused with status ${response.status}: ${await response.text()}`);
    }
    const waiters: Waiter[] = [];
    const reading = (async () => {
        const decoder = new TextDecoder();
        let buffered = "";
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            const readAt = Date.now();
            buffered += decoder.decode(chunk, { stream: true });
            const blocks = buffered.split("\n\n");
            buffered = blocks.pop() ?? "";
            for (const block of blocks) {
                const delta = deltaOf(block);
                if (delta === undefined) continue;
                const index = waiters.findIndex((waiter) => waiter.accepts(delta));
                if (index >= 0) waiters.splice(index, 1)[0]?.resolve({ delta, readAt });
            }
        }
    })().catch((error) => {
        if (!controller.signal.aborted) throw error;
    });
    void reading;
    return {
        nextDelta(accepts) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error("No matching feed event was read in time")),
                    EVENT_WAIT_MS,
                );
                waiters.push({
                    accepts,
                    resolve: (read) => {
                        clearTimeout(timer);
                        resolve(read);
                    },
                });
            });
        },
        close: () => controller.abort(),
    };
}
