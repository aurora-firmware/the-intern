import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createExportRoute, EXPORT_FREE_SPACE_MARGIN_BYTES } from "../../src/listeners/export_route.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { type ExportDaemon, startExportDaemon, waitFor, webCaller } from "../support/export_daemon.ts";

const NOTE_BYTES = 1_000_000;
const NOTE_COUNT = 24;
const HTTP_CONFLICT = 409;
const MEBIBYTE = 1024 * 1024;

const daemons: ExportDaemon[] = [];
const servers: Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const daemon of daemons.splice(0)) await daemon.stop();
});

async function daemonWithLargeDatabase(): Promise<ExportDaemon> {
    const daemon = await startExportDaemon();
    daemons.push(daemon);
    const job = (await daemon.daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as { id: string };
    const text = "x".repeat(NOTE_BYTES);
    for (let i = 0; i < NOTE_COUNT; i++) {
        await daemon.daemon.catalogue.invoke("jobs.worklog.add", { job: job.id, text }, webCaller);
    }
    return daemon;
}

function copies(stateDir: string): Promise<string[]> {
    return readdir(join(stateDir, "exports")).then(
        (names) => names.filter((name) => name.startsWith("download-")),
        () => [],
    );
}

type Answer = { response: IncomingMessage; body: Buffer };

/** Starts a download and returns its response once the headers are in, with its body left unread. */
function startDownload(target: { host: string; port: number }): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const call = request({ ...target, method: "GET", path: "/export" });
        call.once("error", reject);
        call.once("response", (response) => {
            response.pause();
            resolve(response);
        });
        call.end();
    });
}

async function readAll(response: IncomingMessage): Promise<Answer> {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.resume();
    await new Promise((resolve) => response.once("end", resolve));
    return { response, body: Buffer.concat(chunks) };
}

function errorOf(answer: Answer): { code: string; message: string } {
    return JSON.parse(answer.body.toString()).error;
}

describe("the export route's single slot", () => {
    it("answers 409 busy to a second request while a download runs, and the file after it ends", async () => {
        const daemon = await daemonWithLargeDatabase();
        const first = await startDownload(daemon.target);

        const second = await readAll(await startDownload(daemon.target));

        assert.equal(second.response.statusCode, HTTP_CONFLICT);
        assert.equal(errorOf(second).code, "busy");
        const finished = await readAll(first);
        assert.equal(finished.response.statusCode, 200, "the running download went on");
        assert.equal(finished.body.length, Number(finished.response.headers["content-length"]));
        await waitFor(async () => (await copies(daemon.env.stateDir)).length === 0, "the copy to be removed");

        const third = await readAll(await startDownload(daemon.target));
        assert.equal(third.response.statusCode, 200);
    });
});

type StubInvoke = (name: string, input: unknown, caller: Caller) => Promise<unknown>;

const quietLogger = createLogger({ verbose: false, stream: { write: () => true } });

async function listen(server: Server): Promise<{ host: string; port: number }> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
}

function statusOf(daemon: ExportDaemon): { phase: string; instance: Record<string, string> } {
    const { configDir, stateDir, dataDir, runtimeDir } = daemon.env;
    return { phase: "ready", instance: { configDir, stateDir, dataDir, runtimeDir } };
}

describe("the export route when jobs.export answers busy", () => {
    it("answers 409 busy, frees the slot and leaves no copy", async () => {
        const daemon = await startExportDaemon();
        daemons.push(daemon);
        let refuse = true;
        const invoke: StubInvoke = async (name, input) => {
            if (name === "daemon.status") return statusOf(daemon);
            const path = (input as { path: string }).path;
            await writeFile(path, "copy");
            if (refuse) throw new ServiceError("busy", "the database is busy");
            return { path, size: 4 };
        };
        const route = createExportRoute({
            invoke,
            wayIn: "web interface",
            observe: () => ({}),
            logger: quietLogger,
            readFreeSpace: async () => Number.MAX_SAFE_INTEGER,
        });
        const target = await listen(createServer((req, res) => void route(req, res)));

        const refused = await readAll(await startDownload(target));
        assert.equal(refused.response.statusCode, HTTP_CONFLICT);
        assert.equal(errorOf(refused).code, "busy");
        await waitFor(async () => (await copies(daemon.env.stateDir)).length === 0, "the copy to be removed");

        refuse = false;
        const next = await readAll(await startDownload(target));
        assert.equal(next.response.statusCode, 200, "the slot was free again");
    });
});

describe("the export route when the file system has too little space", () => {
    it("answers 409 conflict naming the space needed and makes no copy", async () => {
        const daemon = await daemonWithLargeDatabase();
        let copyCalls = 0;
        const listener = createNetworkListenerComponent({ freePort: true, readFreeSpace: async () => MEBIBYTE });
        const context = {
            config: { current: () => ({ address: "127.0.0.1", port: 0 }) },
            catalogue: {
                invoke: async (name: string, input: unknown, caller: Caller) => {
                    if (name === "jobs.export") copyCalls++;
                    return daemon.daemon.catalogue.invoke(name, input, caller);
                },
            },
            dirs: { stateDir: daemon.env.stateDir },
            logger: quietLogger,
        } as unknown as ServiceContext;
        await listener.start?.(context);
        try {
            const target = listener.address() as { host: string; port: number };
            const answer = await readAll(await startDownload(target));

            assert.equal(answer.response.statusCode, HTTP_CONFLICT);
            const error = errorOf(answer);
            assert.equal(error.code, "conflict");
            const needed = /(\d+) bytes/.exec(error.message);
            assert.ok(needed, `the message names the space needed: ${error.message}`);
            assert.ok(Number(needed[1]) >= EXPORT_FREE_SPACE_MARGIN_BYTES + (NOTE_BYTES * NOTE_COUNT) / 2);
            assert.equal(copyCalls, 0, "jobs.export was never asked");
            assert.deepEqual(await copies(daemon.env.stateDir), []);
        } finally {
            await listener.stop?.();
        }
    });
});
