import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../../src/daemon/logger.ts";
import { createHttpFront, type Fallback, type WayIn } from "../../src/listeners/http_front.ts";
import { type AnyOperation, type Caller, createCatalogue, defineOperation } from "../../src/service/operations.ts";

const SILENT_LOGGER: Logger = { error: () => {}, info: () => {}, debug: () => {} };
const JSON_TYPE = { "content-type": "application/json" };

type TestContext = { calls: { name: string; input: unknown; caller: Caller }[] };

type Reply = { status: number; headers: IncomingHttpHeaders; body: unknown };

type CallOptions = { method?: string; headers?: Record<string, string | number>; body?: string | Buffer };

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
    options: { wayIn?: WayIn; fallback?: Fallback } = {},
): Promise<Harness> {
    const context: TestContext = { calls: [] };
    const catalogue = createCatalogue(operations, { context, phase: () => "ready", logger: SILENT_LOGGER });
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
            req.end(callOptions.body);
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
