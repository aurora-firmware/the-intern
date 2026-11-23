import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { FrontRequestContext, HttpFront } from "../../src/listeners/http_front.ts";
import {
    LISTENER_TIMEOUT_MS,
    type ListenerServer,
    type ListenTarget,
    startListenerServer,
} from "../../src/listeners/listener_server.ts";

const SUBMISSIONS_WAIT_MAX_MS = 5 * 60 * 1000;
const FLUSH_GRACE_MS = 1_000;
const STOP_LIMIT_MS = 2_000;
const LOOPBACK = "127.0.0.1";

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: FrontRequestContext) => Promise<void>;
type Reply = { status: number; body: string };

const servers: ListenerServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function stubFront(handle: Handler): HttpFront {
    return { handle };
}

const answerOk: Handler = async (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${req.method} ${req.url}`);
};

/** Answers 503 once the signal aborts, as the front does for a running call (T-095). */
const answerUnavailableOnAbort: Handler = async (_req, res, ctx) => {
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("stopping");
};

/** Never answers and ignores the signal, as a call that holds its connection. */
const neverAnswer: Handler = () => new Promise(() => {});

async function socketTarget(): Promise<{ path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "bob-listener-"));
    dirs.push(dir);
    return { path: join(dir, "listener.sock") };
}

async function start(handle: Handler, target: ListenTarget): Promise<ListenerServer> {
    const server = await startListenerServer(stubFront(handle), target);
    servers.push(server);
    return server;
}

type SendOptions = { method?: string; body?: string; isBodyIncomplete?: boolean };

function connectionOf(target: ListenTarget): { socketPath: string } | { host: string; port: number } {
    return "path" in target ? { socketPath: target.path } : { host: target.host, port: target.port };
}

function send(target: ListenTarget, path: string, options: SendOptions = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = request({ ...connectionOf(target), path, method: options.method ?? "GET" }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            res.on("error", reject);
        });
        req.on("error", reject);
        if (options.body !== undefined) req.write(options.body);
        if (!options.isBodyIncomplete) req.end();
    });
}

/** Resolves once the front has received the request, so a test can act while it is still running. */
function recordingArrival(handle: Handler): { handle: Handler; arrived: Promise<void> } {
    const { promise: arrived, resolve } = Promise.withResolvers<void>();
    return {
        arrived,
        handle: (req, res, ctx) => {
            resolve();
            return handle(req, res, ctx);
        },
    };
}

async function timed(action: () => Promise<void>): Promise<number> {
    const startedAt = performance.now();
    await action();
    return performance.now() - startedAt;
}

describe("startListenerServer serving", () => {
    it("passes a request on a socket path to the front and reports the path", async () => {
        const target = await socketTarget();
        const server = await start(answerOk, target);

        const reply = await send(server.address, "/operations/daemon.status", { method: "POST" });

        assert.deepEqual(server.address, target);
        assert.deepEqual(reply, { status: 200, body: "POST /operations/daemon.status" });
    });

    it("passes a request on a host and port to the front and reports the port in use", async () => {
        const server = await start(answerOk, { host: LOOPBACK, port: 0 });

        const reply = await send(server.address, "/feed?scope=instance");

        assert.ok("port" in server.address);
        assert.equal(server.address.host, LOOPBACK);
        assert.equal(server.address.port, (server.server.address() as AddressInfo).port);
        assert.notEqual(server.address.port, 0);
        assert.deepEqual(reply, { status: 200, body: "GET /feed?scope=instance" });
    });

    it("answers 500 when the front rejects, and keeps serving", async () => {
        let calls = 0;
        const server = await start(
            async (req, res, ctx) => {
                calls += 1;
                if (calls === 1) throw new Error("the front failed");
                await answerOk(req, res, ctx);
            },
            await socketTarget(),
        );

        const failed = await send(server.address, "/first");
        const next = await send(server.address, "/second");

        assert.equal(failed.status, 500);
        assert.deepEqual(next, { status: 200, body: "GET /second" });
    });
});

describe("startListenerServer front failure after the answer began", () => {
    it("closes the connection when the front rejects after sending headers, and keeps serving", async () => {
        let calls = 0;
        const server = await start(
            async (req, res, ctx) => {
                calls += 1;
                if (calls > 1) return answerOk(req, res, ctx);
                res.writeHead(200, { "content-type": "text/plain" });
                res.write("partial");
                throw new Error("the front failed mid-answer");
            },
            await socketTarget(),
        );

        const failed = send(server.address, "/first").then(
            () => "answered",
            () => "closed",
        );

        assert.equal(await failed, "closed");
        assert.deepEqual(await send(server.address, "/second"), { status: 200, body: "GET /second" });
    });
});

describe("startListenerServer timeouts", () => {
    it("sets the request and idle timeouts to LISTENER_TIMEOUT_MS, above the longest wait", async () => {
        const server = await start(answerOk, await socketTarget());

        assert.equal(LISTENER_TIMEOUT_MS, 330_000);
        assert.ok(LISTENER_TIMEOUT_MS > SUBMISSIONS_WAIT_MAX_MS);
        assert.equal(server.server.requestTimeout, LISTENER_TIMEOUT_MS);
        assert.equal(server.server.timeout, LISTENER_TIMEOUT_MS);
    });

    it("keeps the headers timeout finite", async () => {
        const server = await start(answerOk, await socketTarget());

        assert.ok(server.server.headersTimeout > 0);
        assert.ok(server.server.headersTimeout <= LISTENER_TIMEOUT_MS);
    });
});

describe("startListenerServer stop", () => {
    it("aborts the signal so a running call is answered, and resolves well within the limit", async () => {
        const front = recordingArrival(answerUnavailableOnAbort);
        const server = await start(front.handle, await socketTarget());
        const pending = send(server.address, "/operations/submissions.wait", { method: "POST" });
        await front.arrived;

        const elapsed = await timed(() => server.stop());

        assert.deepEqual(await pending, { status: 503, body: "stopping" });
        assert.ok(elapsed < FLUSH_GRACE_MS, `stop took ${elapsed} ms`);
    });

    it("closes a call that ignores the signal after the grace and resolves within the limit", async () => {
        const front = recordingArrival(neverAnswer);
        const server = await start(front.handle, await socketTarget());
        const pending = send(server.address, "/operations/submissions.wait", { method: "POST" });
        const outcome = pending.then(
            () => "answered",
            () => "closed",
        );
        await front.arrived;

        const elapsed = await timed(() => server.stop());

        assert.equal(await outcome, "closed");
        assert.ok(elapsed < STOP_LIMIT_MS, `stop took ${elapsed} ms`);
    });

    it("closes a connection still uploading its body within the limit", async () => {
        const front = recordingArrival(neverAnswer);
        const server = await start(front.handle, await socketTarget());
        const pending = send(server.address, "/operations/jobs.submit", {
            method: "POST",
            body: '{"partial":',
            isBodyIncomplete: true,
        });
        const outcome = pending.then(
            () => "answered",
            () => "closed",
        );
        await front.arrived;

        const elapsed = await timed(() => server.stop());

        assert.equal(await outcome, "closed");
        assert.ok(elapsed < STOP_LIMIT_MS, `stop took ${elapsed} ms`);
    });

    it("stops accepting connections", async () => {
        const server = await start(answerOk, { host: LOOPBACK, port: 0 });
        const { address } = server;

        await server.stop();

        await assert.rejects(send(address, "/after"), /ECONNREFUSED/);
    });

    it("resolves a second stop as well", async () => {
        const server = await start(answerOk, await socketTarget());

        await server.stop();

        await server.stop();
    });
});

describe("startListenerServer listen failure", () => {
    it("rejects naming the host, the port and the reason when the port is in use", async () => {
        const holder = createServer();
        await new Promise<void>((resolve) => holder.listen(0, LOOPBACK, resolve));
        const { port } = holder.address() as AddressInfo;
        try {
            await assert.rejects(
                startListenerServer(stubFront(answerOk), { host: LOOPBACK, port }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, new RegExp(`${LOOPBACK}:${port}`));
                    assert.match(error.message, /EADDRINUSE/);
                    return true;
                },
            );
        } finally {
            await new Promise((resolve) => holder.close(resolve));
        }
    });

    it("rejects naming the socket path and the reason when its directory is missing", async () => {
        const { path } = await socketTarget();
        const missing = join(path, "missing", "listener.sock");

        await assert.rejects(startListenerServer(stubFront(answerOk), { path: missing }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(missing), error.message);
            // The operating system's code for a missing directory differs by call; any code is the reason.
            assert.match(error.message, /\bE[A-Z]+\b/);
            return true;
        });
    });
});
