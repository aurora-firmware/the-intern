import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { type ClientRequest, createServer, type IncomingMessage, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../../src/daemon/logger.ts";
import { createSubscription, type Subscription } from "../../src/feed/observation_feed.ts";
import { createHttpFront } from "../../src/listeners/http_front.ts";
import { type Caller, createCatalogue, defineOperation, ServiceError } from "../../src/service/operations.ts";

const SILENT_LOGGER: Logger = { error: () => {}, info: () => {}, debug: () => {} };

type TestDelta = { seq: number; text: string };
type FeedParts = ReturnType<typeof createSubscription<{ view: string }, TestDelta>>;
type SubscribeCall = { input: unknown; caller: Caller };
type FeedEvent = { event?: string; id?: string; data?: string };

/** A hand-made subscription the test drives, and a promise that settles when the stream closes it. */
type ServedFeed = FeedParts & { closeCalled: Promise<void> };

function serveFeed(snapshot: { view: string }, maxPending?: number): ServedFeed {
    const parts = createSubscription<{ view: string }, TestDelta>(snapshot, maxPending);
    const { promise: closeCalled, resolve } = Promise.withResolvers<void>();
    const original = parts.subscription.close;
    parts.subscription.close = () => {
        resolve();
        original();
    };
    return { ...parts, closeCalled };
}

type Harness = {
    calls: SubscribeCall[];
    abort: AbortController;
    feed: ServedFeed;
    open(path: string): Promise<IncomingMessage & { clientRequest: ClientRequest }>;
    close(): Promise<void>;
};

async function startFront(options: { serverTimeoutMs?: number; maxPending?: number } = {}): Promise<Harness> {
    const calls: SubscribeCall[] = [];
    const feed = serveFeed({ view: "start" }, options.maxPending);
    const subscribe = defineOperation<unknown, unknown, Subscription<unknown, TestDelta>>({
        name: "feed.subscribe",
        kind: "read",
        parse: (raw) => raw,
        async run(_context, input, caller) {
            calls.push({ input, caller });
            const { conversationId } = input as { conversationId?: string };
            if (conversationId === "unknown") throw new ServiceError("not_found", "No conversation unknown");
            return feed.subscription;
        },
    });
    const catalogue = createCatalogue([subscribe], { context: {}, phase: () => "ready", logger: SILENT_LOGGER });
    const front = createHttpFront({ catalogue, wayIn: "web interface" });
    const abort = new AbortController();
    const server: Server = createServer((req, res) => {
        void front.handle(req, res, { signal: abort.signal });
    });
    if (options.serverTimeoutMs !== undefined) server.setTimeout(options.serverTimeoutMs);
    const dir = await mkdtemp(join(tmpdir(), "bob-feed-"));
    const socketPath = join(dir, "front.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    function open(path: string): Promise<IncomingMessage & { clientRequest: ClientRequest }> {
        return new Promise((resolve, reject) => {
            const req = request({ socketPath, path, method: "GET" }, (res) =>
                resolve(Object.assign(res, { clientRequest: req })),
            );
            req.on("error", reject);
            req.end();
        });
    }

    async function close(): Promise<void> {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    }

    return { calls, abort, feed, open, close };
}

function parseEvent(block: string): FeedEvent {
    const event: FeedEvent = {};
    for (const line of block.split("\n")) {
        const separator = line.indexOf(": ");
        const field = line.slice(0, separator) as keyof FeedEvent;
        event[field] = line.slice(separator + 2);
    }
    return event;
}

/** Reads Server-Sent Events from a response, one at a time. */
function eventReader(res: IncomingMessage): { next(): Promise<FeedEvent>; rest(): Promise<FeedEvent[]> } {
    let text = "";
    const ended = new Promise<void>((resolve) => res.on("end", resolve));
    let wake: (() => void) | undefined;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
        text += chunk;
        wake?.();
    });
    res.on("end", () => wake?.());

    function takeEvent(): FeedEvent | undefined {
        const boundary = text.indexOf("\n\n");
        if (boundary === -1) return undefined;
        const block = text.slice(0, boundary);
        text = text.slice(boundary + 2);
        return parseEvent(block);
    }

    async function next(): Promise<FeedEvent> {
        for (;;) {
            const event = takeEvent();
            if (event) return event;
            if (res.readableEnded) throw new Error(`Stream ended with no further event; left: ${JSON.stringify(text)}`);
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    }

    async function rest(): Promise<FeedEvent[]> {
        await ended;
        const events: FeedEvent[] = [];
        for (let event = takeEvent(); event; event = takeEvent()) events.push(event);
        return events;
    }

    return { next, rest };
}

describe("feed stream: snapshot then deltas", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront();
    });
    afterEach(() => harness.close());

    it("answers text/event-stream with the snapshot, then each delta with its seq as id, in order", async () => {
        const res = await harness.open("/feed?scope=conversation&id=c-1");
        const events = eventReader(res);

        assert.equal(res.statusCode, 200);
        assert.match(res.headers["content-type"] ?? "", /^text\/event-stream/);
        assert.deepEqual(await events.next(), { event: "snapshot", data: '{"view":"start"}' });
        harness.feed.push({ seq: 1, text: "a" });
        harness.feed.push({ seq: 2, text: "b" });
        assert.deepEqual(await events.next(), { event: "delta", id: "1", data: '{"seq":1,"text":"a"}' });
        assert.deepEqual(await events.next(), { event: "delta", id: "2", data: '{"seq":2,"text":"b"}' });
    });

    it("subscribes to the conversation named in the query as a team member", async () => {
        await harness.open("/feed?scope=conversation&id=c-1");

        assert.deepEqual(harness.calls, [
            {
                input: { scope: "conversation", conversationId: "c-1" },
                caller: { actor: { kind: "team_member", wayIn: "web interface" } },
            },
        ]);
    });

    it("subscribes to the instance feed for the instance scope", async () => {
        await harness.open("/feed?scope=instance");

        assert.deepEqual(harness.calls[0]?.input, { scope: "instance" });
    });
});

async function readErrorCode(res: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error: { code: string; message: string } };
    assert.equal(typeof body.error.message, "string");
    return body.error.code;
}

describe("feed stream: refusals before any event", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront();
    });
    afterEach(() => harness.close());

    const refused = [
        { label: "no scope", path: "/feed", status: 400, code: "invalid_input" },
        { label: "an unknown scope", path: "/feed?scope=everything", status: 400, code: "invalid_input" },
        {
            label: "a conversation scope with no id",
            path: "/feed?scope=conversation",
            status: 400,
            code: "invalid_input",
        },
        { label: "an empty conversation id", path: "/feed?scope=conversation&id=", status: 400, code: "invalid_input" },
        {
            label: "an unknown conversation",
            path: "/feed?scope=conversation&id=unknown",
            status: 404,
            code: "not_found",
        },
    ];

    for (const { label, path, status, code } of refused) {
        it(`answers ${status} ${code} with the JSON error body for ${label}`, async () => {
            const res = await harness.open(path);

            assert.equal(res.statusCode, status);
            assert.match(res.headers["content-type"] ?? "", /^application\/json/);
            assert.equal(await readErrorCode(res), code);
        });
    }
});

describe("feed stream: a closed subscription", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront();
    });
    afterEach(() => harness.close());

    for (const reason of ["lagging", "stopped"] as const) {
        it(`writes an end event with the reason ${reason} and ends the response`, async () => {
            const res = await harness.open("/feed?scope=instance");
            const events = eventReader(res);
            await events.next();

            harness.feed.end(reason);

            assert.deepEqual(await events.rest(), [{ event: "end", data: JSON.stringify({ reason }) }]);
        });
    }
});

describe("feed stream: the client leaves", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront();
    });
    afterEach(() => harness.close());

    it("closes the subscription, which ends unsubscribed, when the client closes the connection", async () => {
        const res = await harness.open("/feed?scope=instance");
        await eventReader(res).next();

        res.clientRequest.destroy();
        await harness.feed.closeCalled;

        assert.deepEqual(await harness.feed.subscription.next(), { closed: "unsubscribed" });
    });
});

const LARGE_TEXT = "x".repeat(64 * 1024);

describe("feed stream: a client that doesn't read", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront({ maxPending: 10 });
    });
    afterEach(() => harness.close());

    it("pulls no further delta until the response drains, so the subscription closes lagging", async () => {
        const res = await harness.open("/feed?scope=instance");
        const events = eventReader(res);
        await events.next();
        res.pause();

        // 300 deltas of 64 KiB are far more than the socket buffers hold; a yield lets the stream pull between them.
        for (let seq = 1; seq <= 300; seq++) {
            harness.feed.push({ seq, text: LARGE_TEXT });
            await new Promise((resolve) => setImmediate(resolve));
        }
        res.resume();
        const rest = await events.rest();

        const deltaIds = rest.filter((event) => event.event === "delta").map((event) => Number(event.id));
        assert.ok(deltaIds.length < 300 - 10, `the stream wrote ${deltaIds.length} deltas`);
        assert.deepEqual(
            deltaIds,
            deltaIds.map((_, index) => index + 1),
        );
        assert.deepEqual(rest.at(-1), { event: "end", data: '{"reason":"lagging"}' });
    });
});
