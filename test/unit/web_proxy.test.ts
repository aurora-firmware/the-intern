import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const LOOPBACK_ADDRESS = "127.0.0.1";
const INTERN_HOST = "intern.test";
const SNAPSHOT_EVENT = 'event: snapshot\ndata: {"view":"v"}\n\n';
const DELTA_EVENT = 'event: delta\nid: 1\ndata: {"seq":1}\n\n';

type Answer = { status: number; headers: IncomingMessage["headers"]; body: string };
type Upstream = { server: Server; port: number; feeds: ServerResponse[]; calls: string[] };

async function startUpstream(): Promise<Upstream> {
    const feeds: ServerResponse[] = [];
    const calls: string[] = [];
    const server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url?.startsWith("/feed")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(SNAPSHOT_EVENT);
            feeds.push(res);
            return;
        }
        res.writeHead(201, { "x-upstream": "yes", "content-type": "text/plain" });
        res.end(`host=${req.headers.host} method=${req.method}`);
    });
    server.listen(0, LOOPBACK_ADDRESS);
    await once(server, "listening");
    return { server, port: (server.address() as AddressInfo).port, feeds, calls };
}

function openThroughProxy(proxy: WebProxy, target: string, headers: Record<string, string> = {}, method = "GET") {
    return request({ host: LOOPBACK_ADDRESS, port: proxy.port, path: target, method, headers });
}

async function fetchThroughProxy(
    proxy: WebProxy,
    target: string,
    headers: Record<string, string> = {},
    method = "GET",
): Promise<Answer> {
    const req = openThroughProxy(proxy, target, headers, method);
    req.end();
    const [res] = (await once(req, "response")) as [IncomingMessage];
    let body = "";
    for await (const chunk of res) body += chunk;
    return { status: res.statusCode ?? 0, headers: res.headers, body };
}

/** Opens a feed through the proxy and collects what it reads, with a promise for the next chunk. */
async function openFeed(proxy: WebProxy, upstream: Upstream) {
    const req = openThroughProxy(proxy, `http://${INTERN_HOST}:${upstream.port}/feed?scope=instance`);
    req.end();
    const [res] = (await once(req, "response")) as [IncomingMessage];
    const state = { text: "", closed: false };
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
        state.text += chunk;
    });
    const closed = new Promise<void>((resolve) => {
        res.on("close", () => {
            state.closed = true;
            resolve();
        });
    });
    return { state, closed };
}

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, "condition was not met in time");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe("web proxy", () => {
    let proxy: WebProxy;
    let upstream: Upstream;

    beforeEach(async () => {
        proxy = await startWebProxy();
        upstream = await startUpstream();
    });

    afterEach(async () => {
        await proxy.stop();
        for (const feed of upstream.feeds) feed.destroy();
        upstream.server.close();
        upstream.server.closeAllConnections();
    });

    it("forwards a request and returns the answer unchanged", async () => {
        const host = `${INTERN_HOST}:${upstream.port}`;
        const answer = await fetchThroughProxy(proxy, `http://${host}/page`, { host }, "POST");

        assert.equal(answer.status, 201);
        assert.equal(answer.headers["x-upstream"], "yes");
        assert.equal(answer.body, `host=${INTERN_HOST}:${upstream.port} method=POST`);
    });

    it("records the URL and Referer of each request", async () => {
        const url = `http://${INTERN_HOST}:${upstream.port}/page`;
        await fetchThroughProxy(proxy, url, { referer: "http://intern.test/jobs" });
        await fetchThroughProxy(proxy, url);

        assert.deepEqual(proxy.requests(), [
            { url, referer: "http://intern.test/jobs" },
            { url, referer: undefined },
        ]);
    });

    it("connects to the loopback address for the name intern.test", async () => {
        const answer = await fetchThroughProxy(proxy, `http://${INTERN_HOST}:${upstream.port}/`);

        assert.equal(answer.status, 201);
        assert.deepEqual(upstream.calls, ["GET /"]);
    });

    it("answers 502 when the target cannot be reached", async () => {
        const dead = await startUpstream();
        const deadPort = dead.port;
        dead.server.close();

        const answer = await fetchThroughProxy(proxy, `http://${INTERN_HOST}:${deadPort}/`);

        assert.equal(answer.status, 502);
    });

    it("passes feed events on as they arrive and counts their bytes", async () => {
        const feed = await openFeed(proxy, upstream);
        await until(() => feed.state.text === SNAPSHOT_EVENT);
        assert.equal(proxy.feedBytes(), Buffer.byteLength(SNAPSHOT_EVENT));

        await until(() => upstream.feeds.length === 1);
        upstream.feeds[0]?.write(DELTA_EVENT);
        await until(() => feed.state.text === SNAPSHOT_EVENT + DELTA_EVENT);

        assert.equal(proxy.feedBytes(), Buffer.byteLength(SNAPSHOT_EVENT + DELTA_EVENT));
    });

    it("does not count the bytes of other responses", async () => {
        await fetchThroughProxy(proxy, `http://${INTERN_HOST}:${upstream.port}/page`);

        assert.equal(proxy.feedBytes(), 0);
    });

    it("drops feed events after dropFeedEvents until forceFeedEnd", async () => {
        const feed = await openFeed(proxy, upstream);
        await until(() => feed.state.text === SNAPSHOT_EVENT);
        await until(() => upstream.feeds.length === 1);

        proxy.dropFeedEvents();
        upstream.feeds[0]?.write(DELTA_EVENT);
        await until(() => proxy.feedBytes() === Buffer.byteLength(SNAPSHOT_EVENT + DELTA_EVENT));
        assert.equal(feed.state.text, SNAPSHOT_EVENT);

        proxy.forceFeedEnd("lagging");
        await feed.closed;
        assert.equal(feed.state.text, `${SNAPSHOT_EVENT}event: end\ndata: {"reason":"lagging"}\n\n`);
    });

    it("writes an end event with the reason on the open feed streams and closes them", async () => {
        const feed = await openFeed(proxy, upstream);
        await until(() => feed.state.text === SNAPSHOT_EVENT);

        proxy.forceFeedEnd("stopped");
        await feed.closed;

        assert.equal(feed.state.text, `${SNAPSHOT_EVENT}event: end\ndata: {"reason":"stopped"}\n\n`);
    });

    it("passes feed events on again for a feed opened after forceFeedEnd", async () => {
        proxy.dropFeedEvents();
        proxy.forceFeedEnd("lagging");

        const feed = await openFeed(proxy, upstream);

        await until(() => feed.state.text === SNAPSHOT_EVENT);
    });

    it("answers a call of the operation 503 unavailable once, then forwards later calls", async () => {
        proxy.forceUnavailable("jobs.list");
        const url = `http://${INTERN_HOST}:${upstream.port}/operations/jobs.list`;

        const first = await fetchThroughProxy(proxy, url, {}, "POST");
        const second = await fetchThroughProxy(proxy, url, {}, "POST");

        assert.equal(first.status, 503);
        assert.equal(JSON.parse(first.body).error.code, "unavailable");
        assert.equal(second.status, 201);
        assert.deepEqual(upstream.calls, ["POST /operations/jobs.list"]);
    });

    it("forwards calls of other operations while one is forced unavailable", async () => {
        proxy.forceUnavailable("jobs.list");

        const answer = await fetchThroughProxy(
            proxy,
            `http://${INTERN_HOST}:${upstream.port}/operations/jobs.get`,
            {},
            "POST",
        );

        assert.equal(answer.status, 201);
    });
});
