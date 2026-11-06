/**
 * A small forward proxy for the browser tests (ADR-007 decision 10). Playwright sees none of a shared worker's
 * requests, so a test that must see or change them runs the browser through this proxy. It forwards plain HTTP
 * requests, resolves the name `intern.test` to the loopback address itself, records each request's URL and `Referer`,
 * counts the bytes of `/feed` responses, and can drop feed events, end the open feed streams, or answer an operation
 * `503 unavailable` once.
 */
import { type ClientRequest, createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const LOOPBACK_ADDRESS = "127.0.0.1";
const INTERN_HOST = "intern.test";
const FEED_PATH = "/feed";
const OPERATION_PATH_PREFIX = "/operations/";
const EVENT_SEPARATOR = "\n\n";
const UNAVAILABLE_STATUS = 503;
const BAD_GATEWAY_STATUS = 502;

export type FeedEndReason = "lagging" | "stopped";

export type RecordedRequest = { url: string; referer: string | undefined };

export type WebProxy = {
    port: number;
    /** Every request that went through the proxy, in order. */
    requests(): RecordedRequest[];
    /** The response bytes received on `/feed` connections. */
    feedBytes(): number;
    /** Drops feed events from now until `forceFeedEnd`. */
    dropFeedEvents(): void;
    /** Writes an `end` event with the reason on the open feed streams, closes them, and stops dropping events. */
    forceFeedEnd(reason: FeedEndReason): void;
    /** Answers the next call of the operation `503` with the `unavailable` error body. */
    forceUnavailable(operationName: string): void;
    stop(): Promise<void>;
};

type OpenFeed = { res: ServerResponse; upstream: ClientRequest };

function operationNameOf(url: URL): string | undefined {
    if (!url.pathname.startsWith(OPERATION_PATH_PREFIX)) return undefined;
    return url.pathname.slice(OPERATION_PATH_PREFIX.length);
}

function sendUnavailable(res: ServerResponse, operationName: string): void {
    const body = JSON.stringify({
        error: { code: "unavailable", message: `Operation ${operationName} was forced unavailable by the test proxy` },
    });
    res.writeHead(UNAVAILABLE_STATUS, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
}

function sendBadGateway(res: ServerResponse, error: Error): void {
    if (res.headersSent) {
        res.destroy(error);
        return;
    }
    res.writeHead(BAD_GATEWAY_STATUS, { "content-type": "text/plain" });
    res.end(`The test proxy could not reach the target: ${error.message}`);
}

export async function startWebProxy(): Promise<WebProxy> {
    const recorded: RecordedRequest[] = [];
    const openFeeds = new Set<OpenFeed>();
    const unavailableOnce = new Set<string>();
    let feedByteCount = 0;
    let isDroppingFeedEvents = false;

    function relayFeed(upstreamRes: IncomingMessage, open: OpenFeed): void {
        let pending = "";
        upstreamRes.setEncoding("utf8");
        upstreamRes.on("data", (chunk: string) => {
            feedByteCount += Buffer.byteLength(chunk);
            pending += chunk;
            const end = pending.lastIndexOf(EVENT_SEPARATOR);
            if (end < 0) return;
            const events = pending.slice(0, end + EVENT_SEPARATOR.length);
            pending = pending.slice(end + EVENT_SEPARATOR.length);
            if (!isDroppingFeedEvents) open.res.write(events);
        });
        upstreamRes.on("end", () => {
            if (openFeeds.delete(open)) open.res.end();
        });
    }

    function forward(req: IncomingMessage, res: ServerResponse, target: URL): void {
        const isFeed = target.pathname === FEED_PATH;
        const host = target.hostname === INTERN_HOST ? LOOPBACK_ADDRESS : target.hostname;
        const upstream = request(
            {
                host,
                port: target.port || 80,
                path: target.pathname + target.search,
                method: req.method,
                headers: req.headers,
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode ?? BAD_GATEWAY_STATUS, upstreamRes.headers);
                if (!isFeed) {
                    upstreamRes.pipe(res);
                    return;
                }
                const open = { res, upstream };
                openFeeds.add(open);
                res.on("close", () => {
                    openFeeds.delete(open);
                    upstream.destroy();
                });
                relayFeed(upstreamRes, open);
            },
        );
        upstream.on("error", (error) => sendBadGateway(res, error));
        req.pipe(upstream);
    }

    const server = createServer((req, res) => {
        const target = new URL(req.url ?? "/");
        recorded.push({ url: req.url ?? "", referer: req.headers.referer });
        const operationName = operationNameOf(target);
        if (operationName !== undefined && unavailableOnce.delete(operationName)) {
            req.resume();
            sendUnavailable(res, operationName);
            return;
        }
        forward(req, res, target);
    });
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK_ADDRESS, resolve));

    return {
        port: (server.address() as AddressInfo).port,
        requests: () => [...recorded],
        feedBytes: () => feedByteCount,
        dropFeedEvents: () => {
            isDroppingFeedEvents = true;
        },
        forceFeedEnd: (reason) => {
            isDroppingFeedEvents = false;
            for (const { res, upstream } of openFeeds) {
                res.end(`event: end\ndata: ${JSON.stringify({ reason })}${EVENT_SEPARATOR}`);
                upstream.destroy();
            }
            openFeeds.clear();
        },
        forceUnavailable: (operationName) => {
            unavailableOnce.add(operationName);
        },
        stop: async () => {
            for (const { res, upstream } of openFeeds) {
                res.destroy();
                upstream.destroy();
            }
            openFeeds.clear();
            server.close();
            server.closeAllConnections();
        },
    };
}
