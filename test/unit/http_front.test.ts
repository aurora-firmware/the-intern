import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../../src/daemon/logger.ts";
import {
    createHttpFront,
    type Fallback,
    MAX_BODY_BYTES,
    STATUS_BY_CODE,
    STREAM_ROUTES,
    type WayIn,
} from "../../src/listeners/http_front.ts";
import {
    type AnyOperation,
    type Caller,
    type Catalogue,
    createCatalogue,
    defineOperation,
    ServiceError,
    type ServiceErrorCode,
} from "../../src/service/operations.ts";

const SILENT_LOGGER: Logger = { error: () => {}, info: () => {}, debug: () => {} };
const JSON_TYPE = { "content-type": "application/json" };

type TestContext = { calls: { name: string; input: unknown; caller: Caller }[] };

type Reply = { status: number; headers: IncomingHttpHeaders; body: unknown };

type CallOptions = {
    method?: string;
    headers?: Record<string, string | number>;
    body?: string | Buffer;
    /** Sends the body without ending the request, as a client still uploading. */
    isBodyIncomplete?: boolean;
};

function recordingOperation(name: string, run: (input: unknown) => Promise<unknown>): AnyOperation<TestContext> {
    return defineOperation<TestContext, unknown, unknown>({
        name,
        kind: "read",
        parse: (raw) => raw,
        async run(context, input, caller) {
            context.calls.push({ name, input, caller });
            return run(input);
        },
    });
}

type Harness = {
    context: TestContext;
    abort: AbortController;
    call(path: string, options?: CallOptions): Promise<Reply>;
    close(): Promise<void>;
};

async function startFront(
    operations: AnyOperation<TestContext>[],
    options: { wayIn?: WayIn; fallback?: Fallback; catalogue?: Catalogue } = {},
): Promise<Harness> {
    const context: TestContext = { calls: [] };
    const catalogue =
        options.catalogue ?? createCatalogue(operations, { context, phase: () => "ready", logger: SILENT_LOGGER });
    const front = createHttpFront({ catalogue, wayIn: options.wayIn ?? "command line", fallback: options.fallback });
    const abort = new AbortController();
    const server: Server = createServer((req, res) => {
        void front.handle(req, res, { signal: abort.signal });
    });
    const dir = await mkdtemp(join(tmpdir(), "bob-front-"));
    const socketPath = join(dir, "front.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    function call(path: string, callOptions: CallOptions = {}): Promise<Reply> {
        return new Promise((resolve, reject) => {
            const req = request(
                { socketPath, path, method: callOptions.method ?? "POST", headers: callOptions.headers },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text) });
                    });
                },
            );
            req.on("error", reject);
            if (callOptions.isBodyIncomplete) req.write(callOptions.body ?? "");
            else req.end(callOptions.body);
        });
    }

    async function close(): Promise<void> {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    }

    return { context, abort, call, close };
}

const echo = recordingOperation("test.echo", async (input) => ({ echoed: input }));

describe("http front: operation calls", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront([echo], { wayIn: "web interface" });
    });
    afterEach(() => harness.close());

    it("answers 200 with the operation's result for a valid JSON body", async () => {
        const reply = await harness.call("/operations/test.echo", {
            headers: JSON_TYPE,
            body: JSON.stringify({ text: "hi" }),
        });

        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, { result: { echoed: { text: "hi" } } });
    });

    it("calls the operation as a team member with the way in from the front's options", async () => {
        await harness.call("/operations/test.echo", {
            headers: { ...JSON_TYPE, "x-way-in": "command line" },
            body: JSON.stringify({ wayIn: "command line", actor: { kind: "agent" } }),
        });

        assert.deepEqual(harness.context.calls[0]?.caller, { actor: { kind: "team_member", wayIn: "web interface" } });
    });
});

function assertError(reply: Reply, status: number, code: string): string {
    assert.equal(reply.status, status);
    const error = (reply.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    return error.message;
}

/** A JSON string literal whose encoding is exactly `bytes` long. */
function jsonStringOfBytes(bytes: number): string {
    return `"${"a".repeat(bytes - 2)}"`;
}

describe("http front: request validation", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront([echo]);
    });
    afterEach(() => harness.close());

    const refusedRequests: { label: string; options: CallOptions }[] = [
        { label: "a text/plain body", options: { headers: { "content-type": "text/plain" }, body: '{"a":1}' } },
        {
            label: "a form body",
            options: { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" },
        },
        { label: "an empty body with no content type", options: {} },
        { label: "a JSON body with no content type", options: { body: '{"a":1}' } },
        { label: "malformed JSON", options: { headers: JSON_TYPE, body: '{"a":' } },
        {
            label: "a body of 10 MiB plus one byte",
            options: { headers: JSON_TYPE, body: jsonStringOfBytes(MAX_BODY_BYTES + 1) },
        },
        {
            label: "a chunked body of 10 MiB plus one byte",
            options: {
                headers: { ...JSON_TYPE, "transfer-encoding": "chunked" },
                body: jsonStringOfBytes(MAX_BODY_BYTES + 1),
            },
        },
    ];

    for (const { label, options } of refusedRequests) {
        it(`refuses ${label} with 400 invalid_input without calling the operation`, async () => {
            const reply = await harness.call("/operations/test.echo", options);

            assertError(reply, 400, "invalid_input");
            assert.deepEqual(harness.context.calls, []);
        });
    }

    it("refuses a body declared larger than 10 MiB before the rest of it is sent", async () => {
        const reply = await harness.call("/operations/test.echo", {
            headers: { ...JSON_TYPE, "content-length": MAX_BODY_BYTES + 1 },
            body: '"a',
            isBodyIncomplete: true,
        });

        assertError(reply, 400, "invalid_input");
        assert.deepEqual(harness.context.calls, []);
    });

    it("accepts a JSON body of exactly 10 MiB", async () => {
        const body = jsonStringOfBytes(MAX_BODY_BYTES);

        const reply = await harness.call("/operations/test.echo", { headers: JSON_TYPE, body });

        assert.equal(reply.status, 200);
        assert.equal(harness.context.calls[0]?.input, JSON.parse(body));
    });

    it("calls the operation with no input for an empty body declared application/json with a charset", async () => {
        const reply = await harness.call("/operations/test.echo", {
            headers: { "content-type": "application/json; charset=utf-8" },
        });

        assert.equal(reply.status, 200);
        assert.equal(harness.context.calls.length, 1);
        assert.equal(harness.context.calls[0]?.input, undefined);
    });
});

describe("http front: error outcomes", () => {
    const expectedStatuses: [ServiceErrorCode, number][] = [
        ["invalid_input", 400],
        ["not_found", 404],
        ["busy", 409],
        ["conflict", 409],
        ["unavailable", 503],
        ["internal", 500],
    ];

    it("maps every service error code to its HTTP status", () => {
        assert.deepEqual(Object.entries(STATUS_BY_CODE).sort(), [...expectedStatuses].sort());
    });

    for (const [code, status] of expectedStatuses) {
        it(`answers ${status} with the code ${code} and the message unchanged`, async () => {
            const message = `the operation failed with ${code}: "quoted" détails`;
            const failing = recordingOperation("test.fail", async () => {
                throw new ServiceError(code, message);
            });
            const harness = await startFront([failing]);
            try {
                const reply = await harness.call("/operations/test.fail", { headers: JSON_TYPE });

                assert.equal(assertError(reply, status, code), message);
            } finally {
                await harness.close();
            }
        });
    }

    it("answers 500 internal when the catalogue fails with something other than a service error", async () => {
        const brokenCatalogue: Catalogue = {
            list: () => [],
            invoke: async () => {
                throw new Error("catalogue broke");
            },
        };
        const harness = await startFront([], { catalogue: brokenCatalogue });
        try {
            const reply = await harness.call("/operations/test.any", { headers: JSON_TYPE });

            assertError(reply, 500, "internal");
        } finally {
            await harness.close();
        }
    });
});

describe("http front: routes", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = await startFront([echo]);
    });
    afterEach(() => harness.close());

    it("answers 404 not_found naming an unknown operation", async () => {
        const reply = await harness.call("/operations/no.such", { headers: JSON_TYPE });

        assert.match(assertError(reply, 404, "not_found"), /no\.such/);
    });

    const unroutedRequests: { method: string; path: string }[] = [
        { method: "GET", path: "/operations/test.echo" },
        { method: "GET", path: "/nothing" },
        { method: "POST", path: "/nothing" },
        { method: "POST", path: "/operations/" },
        { method: "POST", path: "/operations/test.echo/extra" },
    ];

    for (const { method, path } of unroutedRequests) {
        it(`answers 404 not_found naming the path for ${method} ${path}`, async () => {
            const reply = await harness.call(path, { method, headers: JSON_TYPE });

            assert.ok(assertError(reply, 404, "not_found").includes(path));
            assert.deepEqual(harness.context.calls, []);
        });
    }

    it("refuses feed.subscribe at the operation route with 400 invalid_input naming GET /feed", async () => {
        const reply = await harness.call("/operations/feed.subscribe", {
            headers: JSON_TYPE,
            body: JSON.stringify({ scope: "instance" }),
        });

        assert.match(assertError(reply, 400, "invalid_input"), /GET \/feed/);
    });

    it("treats an operation named like an object property as an unknown operation", async () => {
        const reply = await harness.call("/operations/constructor", { headers: JSON_TYPE });

        assertError(reply, 404, "not_found");
    });

    it("names GET /feed as the stream route of feed.subscribe", () => {
        assert.deepEqual(STREAM_ROUTES, { "feed.subscribe": "GET /feed" });
    });
});

describe("http front: fallback", () => {
    it("lets the fallback answer a request the front has no route for", async () => {
        const fallback: Fallback = async (_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ servedBy: "fallback" }));
            return true;
        };
        const harness = await startFront([echo], { fallback });
        try {
            const reply = await harness.call("/ui/index.html", { method: "GET" });

            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body, { servedBy: "fallback" });
        } finally {
            await harness.close();
        }
    });

    it("answers 404 not_found naming the path when the fallback declines", async () => {
        const harness = await startFront([echo], { fallback: async () => false });
        try {
            const reply = await harness.call("/ui/missing.html", { method: "GET" });

            assert.ok(assertError(reply, 404, "not_found").includes("/ui/missing.html"));
        } finally {
            await harness.close();
        }
    });

    it("never hands an operation call to the fallback", async () => {
        let fallbackCalls = 0;
        const fallback: Fallback = async () => {
            fallbackCalls += 1;
            return false;
        };
        const harness = await startFront([echo], { fallback });
        try {
            await harness.call("/operations/test.echo", { headers: JSON_TYPE });

            assert.equal(fallbackCalls, 0);
        } finally {
            await harness.close();
        }
    });
});

describe("http front: aborted calls", () => {
    it("answers 503 unavailable when the signal aborts while the operation runs, without cancelling it", {
        timeout: 5000,
    }, async () => {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let isFinished = false;
        const held = recordingOperation("test.held", async () => {
            started.resolve();
            await release.promise;
            isFinished = true;
            return "done";
        });
        const harness = await startFront([held]);
        try {
            const pending = harness.call("/operations/test.held", { headers: JSON_TYPE });
            await started.promise;
            harness.abort.abort();

            assertError(await pending, 503, "unavailable");
            release.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(isFinished, true);
        } finally {
            release.resolve();
            await harness.close();
        }
    });

    it("answers 503 unavailable without calling the operation when the signal has already aborted", async () => {
        const harness = await startFront([echo]);
        try {
            harness.abort.abort();

            const reply = await harness.call("/operations/test.echo", { headers: JSON_TYPE });

            assertError(reply, 503, "unavailable");
            assert.deepEqual(harness.context.calls, []);
        } finally {
            await harness.close();
        }
    });
});

describe("http front: no access checks", () => {
    const foreignHeaders = {
        origin: "https://elsewhere.example",
        host: "attacker.example:9999",
        referer: "https://elsewhere.example/page",
    };

    function corsHeaderNames(headers: IncomingHttpHeaders): string[] {
        return Object.keys(headers).filter((name) => name.startsWith("access-control-"));
    }

    it("answers a call with foreign Origin, Host and Referer headers as without them, with no CORS header", async () => {
        const harness = await startFront([echo]);
        try {
            const body = JSON.stringify({ text: "hi" });
            const plain = await harness.call("/operations/test.echo", { headers: JSON_TYPE, body });
            const foreign = await harness.call("/operations/test.echo", {
                headers: { ...JSON_TYPE, ...foreignHeaders },
                body,
            });

            assert.deepEqual([foreign.status, foreign.body], [plain.status, plain.body]);
            assert.deepEqual(corsHeaderNames(foreign.headers), []);
        } finally {
            await harness.close();
        }
    });

    it("sends no CORS header on a refusal or an unrouted request", async () => {
        const harness = await startFront([echo]);
        try {
            const refused = await harness.call("/operations/test.echo", { headers: foreignHeaders, body: "x" });
            const preflight = await harness.call("/operations/test.echo", {
                method: "OPTIONS",
                headers: foreignHeaders,
            });

            assert.equal(refused.status, 400);
            assert.equal(preflight.status, 404);
            assert.deepEqual([...corsHeaderNames(refused.headers), ...corsHeaderNames(preflight.headers)], []);
        } finally {
            await harness.close();
        }
    });
});
