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
