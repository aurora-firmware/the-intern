/**
 * The client library without a daemon (S-003 REQ-009): the default socket is the daemon's, resolved from the runtime
 * directory, and a call that no daemon answers fails with `UnreachableError` naming where it went (AC-009.2).
 */
import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { browserTransport } from "../../src/client/browser_transport.ts";
import {
    ClientError,
    createClient,
    parseEventStream,
    type StreamEvent,
    UnreachableError,
} from "../../src/client/client.ts";
import { defaultSocketPath, nodeTransport } from "../../src/client/node_transport.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const HOME = "/home/team";

const LOOPBACK = "127.0.0.1";

const envs: HermeticEnv[] = [];
const servers: Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) await closeServer(server);
    for (const env of envs.splice(0)) await env.dispose();
});

function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
}

/** A server on a free loopback port that answers every request with `answer`; resolves with its base URL. */
async function serve(answer: RequestListener): Promise<string> {
    const server = createServer(answer);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
    return `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`;
}

/** The base URL of a loopback port nothing listens on: a server took it, then closed. */
async function refusingUrl(): Promise<string> {
    const baseUrl = await serve(() => {});
    await closeServer(servers.pop() as Server);
    return baseUrl;
}

function assertUnreachable(error: unknown, target: string): void {
    assert.ok(error instanceof UnreachableError, `the call fails with UnreachableError, not ${error}`);
    assert.equal(error.target, target);
    assert.ok(error.message.includes(target), `the message names ${target}: ${error.message}`);
}

describe("defaultSocketPath", () => {
    it("is bob.sock in the runtime directory under XDG_RUNTIME_DIR", () => {
        const path = defaultSocketPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, homeDir: HOME });
        assert.equal(path, "/run/user/1000/the-intern/bob.sock");
    });

    it("falls back to the runtime directory inside the state directory when XDG_RUNTIME_DIR is unset", () => {
        const path = defaultSocketPath({ env: { XDG_STATE_HOME: "/xdg/state" }, homeDir: HOME });
        assert.equal(path, "/xdg/state/the-intern/run/bob.sock");
    });

    it("uses a runtime directory given as an option, as the daemon's flag does", () => {
        const path = defaultSocketPath({
            env: { XDG_RUNTIME_DIR: "/run/user/1000" },
            homeDir: HOME,
            runtimeDir: "/srv/bob/run",
        });
        assert.equal(path, "/srv/bob/run/bob.sock");
    });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        (value) => assert.fail(`the call was answered with ${JSON.stringify(value)}`),
        (error: unknown) => error,
    );
}

describe("a call no daemon answers", () => {
    it("fails with UnreachableError naming the default socket path when no daemon runs on the instance", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const socketPath = defaultSocketPath({ env: env.env, homeDir: env.root });
        const client = createClient(nodeTransport({ socketPath }));

        const error = await rejection(client.invoke("daemon.status"));

        assertUnreachable(error, socketPath);
    });

    it("fails with UnreachableError naming the URL when the connection is refused", async () => {
        const baseUrl = await refusingUrl();

        const error = await rejection(createClient(nodeTransport({ baseUrl })).invoke("daemon.status"));

        assertUnreachable(error, baseUrl);
    });

    it("fails with UnreachableError naming the URL when the connection closes before the answer", async () => {
        const baseUrl = await serve((req) => req.socket.destroy());

        const error = await rejection(createClient(nodeTransport({ baseUrl })).invoke("daemon.status"));

        assertUnreachable(error, baseUrl);
    });

    it("fails with UnreachableError naming the URL when the answer is cut off halfway", async () => {
        const baseUrl = await serve((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", "content-length": 100 });
            res.write('{"result":');
            setImmediate(() => res.destroy());
        });

        const error = await rejection(createClient(nodeTransport({ baseUrl })).invoke("daemon.status"));

        assertUnreachable(error, baseUrl);
    });

    it("fails a subscription with UnreachableError naming the URL when its stream is cut off", async () => {
        const baseUrl = await serve((_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("event: snapshot\ndata: {}\n\n");
            setImmediate(() => res.destroy());
        });
        const feed = createClient(nodeTransport({ baseUrl })).subscribe({ scope: "instance" });

        const first = await feed.next();
        const error = await rejection(feed.next());

        assert.deepEqual(first, { done: false, value: { snapshot: {} } });
        assertUnreachable(error, baseUrl);
    });
});

describe("an answer not in the daemon's format", () => {
    it("fails with an error naming the URL and the status when the body is not JSON", async () => {
        const baseUrl = await serve((_req, res) => {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end("Bad Gateway");
        });

        const error = await rejection(createClient(nodeTransport({ baseUrl })).invoke("daemon.status"));

        assert.ok(error instanceof Error && !(error instanceof UnreachableError), `a plain error, not ${error}`);
        assert.match(error.message, new RegExp(`${baseUrl} is not JSON \\(status 502\\)`));
    });

    it("fails with an error that is not a ClientError when the JSON holds neither a result nor an error", async () => {
        const baseUrl = await serve((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"unexpected":1}');
        });

        const error = await rejection(createClient(nodeTransport({ baseUrl })).invoke("daemon.status"));

        assert.ok(error instanceof Error && !(error instanceof ClientError), `a plain error, not ${error}`);
        assert.match(error.message, /neither a result nor an error/);
    });
});

async function* fromChunks(chunks: readonly string[]): AsyncIterable<string> {
    yield* chunks;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
    const collected: T[] = [];
    for await (const item of items) collected.push(item);
    return collected;
}

describe("parseEventStream", () => {
    it("parses events split anywhere across chunks, with CRLF line ends and comment lines", async () => {
        const text =
            'event: snapshot\ndata: {"a":1}\n\n: keep-alive\r\nevent: delta\r\nid: 1\r\ndata: {"seq":1}\r\n\r\n';
        const chunks = text.match(/.{1,3}/gs) ?? [];

        const events = await collect(parseEventStream(fromChunks(chunks)));

        assert.deepEqual(events, [
            { event: "snapshot", data: '{"a":1}' },
            { event: "delta", id: "1", data: '{"seq":1}' },
        ]);
    });
});

describe("a subscription whose stream closes without an end event", () => {
    it("fails instead of finishing or opening a new stream", async () => {
        const opened: string[] = [];
        const client = createClient({
            call: () => assert.fail("the subscription calls no operation"),
            async *stream(path: string): AsyncIterable<StreamEvent> {
                opened.push(path);
                yield { event: "snapshot", data: "{}" };
            },
        });
        const feed = client.subscribe({ scope: "instance" });

        const first = await feed.next();
        const error = await rejection(feed.next());

        assert.deepEqual(first, { done: false, value: { snapshot: {} } });
        assert.ok(error instanceof Error && !(error instanceof UnreachableError), `a plain error, not ${error}`);
        assert.match(error.message, /closed without an end event/);
        assert.deepEqual(opened, ["/feed?scope=instance"]);
    });
});

/** A fetch double that records each request; a feed answers one snapshot, then silence until the signal aborts. */
function fetchDouble(requests: RequestInit[]): typeof fetch {
    return async (_input, init = {}) => {
        requests.push(init);
        if (init.method === "POST") return new Response('{"result":1}');
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("event: snapshot\ndata: {}\n\n"));
                init.signal?.addEventListener("abort", () => controller.error(new DOMException("x", "AbortError")));
            },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
}

describe("a subscription given an abort signal", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("ends with no error and closes the connection over the Node transport on abort of a quiet stream", async () => {
        const closed = Promise.withResolvers<void>();
        const baseUrl = await serve((req, res) => {
            req.socket.once("close", () => closed.resolve());
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("event: snapshot\ndata: {}\n\n");
        });
        const controller = new AbortController();
        const client = createClient(nodeTransport({ baseUrl }));
        const feed = client.subscribe({ scope: "instance" }, { signal: controller.signal });
        const first = await feed.next();
        const waiting = feed.next();
        controller.abort();

        assert.deepEqual(first, { done: false, value: { snapshot: {} } });
        assert.equal((await waiting).done, true);
        await closed.promise;
    });

    it("ends with no error over the browser transport when it aborts on a quiet stream", async () => {
        const requests: RequestInit[] = [];
        globalThis.fetch = fetchDouble(requests);
        const controller = new AbortController();
        const client = createClient(browserTransport("http://daemon.test"));
        const feed = client.subscribeConversations(["c1"], { signal: controller.signal });
        await feed.next();
        const waiting = feed.next();

        controller.abort();

        assert.equal((await waiting).done, true);
        assert.equal(requests[0]?.signal, controller.signal);
    });

    it("sets cache no-store on a browser feed request and on no operation call", async () => {
        const requests: RequestInit[] = [];
        globalThis.fetch = fetchDouble(requests);
        const controller = new AbortController();
        const client = createClient(browserTransport("http://daemon.test"));
        await client.invoke("daemon.status");
        const feed = client.subscribe({ scope: "instance" }, { signal: controller.signal });
        await feed.next();
        assert.equal(requests[0]?.cache, undefined);
        assert.equal(requests[1]?.cache, "no-store");
        controller.abort();
    });

    it("passes the signal on to the transport's stream, and none when the caller gives none", async () => {
        const seen: (AbortSignal | undefined)[] = [];
        const client = createClient({
            call: () => assert.fail("the subscription calls no operation"),
            async *stream(_path: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
                seen.push(signal);
                yield { event: "end", data: '{"reason":"stopped"}' };
            },
        });
        const controller = new AbortController();

        await client.subscribe({ scope: "instance" }, { signal: controller.signal }).next();
        await client.subscribe({ scope: "instance" }).next();

        assert.deepEqual(seen, [controller.signal, undefined]);
    });
});
