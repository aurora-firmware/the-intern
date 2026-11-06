import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLogger } from "../../src/daemon/logger.ts";
import { createExportRoute } from "../../src/listeners/export_route.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { type ExportDaemon, startExportDaemon, waitFor, webCaller } from "../support/export_daemon.ts";

const NOTE_BYTES = 1_000_000;
const NOTE_COUNT = 24;
const GROUP_AND_OTHER_BITS = 0o077;

const daemons: ExportDaemon[] = [];
const servers: Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const daemon of daemons.splice(0)) await daemon.stop();
});

async function daemonWithLargeDatabase(): Promise<{
    daemon: ExportDaemon;
    job: { id: string; leadConversation: string };
}> {
    const daemon = await startExportDaemon();
    daemons.push(daemon);
    const job = (await daemon.daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as {
        id: string;
        leadConversation: string;
    };
    const text = "x".repeat(NOTE_BYTES);
    for (let i = 0; i < NOTE_COUNT; i++) {
        await daemon.daemon.catalogue.invoke("jobs.worklog.add", { job: job.id, text }, webCaller);
    }
    return { daemon, job };
}

function downloads(stateDir: string): Promise<string[]> {
    return readdir(join(stateDir, "exports")).then(
        (names) => names.filter((name) => name.startsWith("download-")),
        () => [],
    );
}

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

async function drain(response: IncomingMessage): Promise<void> {
    response.resume();
    await new Promise((resolve) => response.once("end", resolve));
}

describe("the export route's temporary copy", () => {
    it("keeps the folder and the file owner-only while the download is held part way", async () => {
        const { daemon } = await daemonWithLargeDatabase();
        const response = await startDownload(daemon.target);

        const [name] = await downloads(daemon.env.stateDir);
        assert.ok(name, "the copy exists while the download is held");
        const folder = join(daemon.env.stateDir, "exports", name);
        assert.equal((await stat(folder)).mode & GROUP_AND_OTHER_BITS, 0, "the folder is owner-only");
        assert.equal((await stat(join(daemon.env.stateDir, "exports"))).mode & GROUP_AND_OTHER_BITS, 0);
        const files = await readdir(folder);
        assert.equal(files.length, 1);
        assert.equal((await stat(join(folder, files[0] as string))).mode & GROUP_AND_OTHER_BITS, 0);
        response.destroy();
    });

    it("leaves no copy when the client leaves part way, and the job's run goes on", async () => {
        const { daemon, job } = await daemonWithLargeDatabase();
        const response = await startDownload(daemon.target);
        assert.equal((await downloads(daemon.env.stateDir)).length, 1);

        response.destroy();

        await waitFor(async () => (await downloads(daemon.env.stateDir)).length === 0, "the copy to be removed");
        const info = await daemon.ctx().host.conversationInfo(job.leadConversation);
        assert.equal(info?.busy, true, "the run goes on");
    });

    it("leaves no copy when the download finishes", async () => {
        const { daemon } = await daemonWithLargeDatabase();
        const response = await startDownload(daemon.target);

        await drain(response);

        await waitFor(async () => (await downloads(daemon.env.stateDir)).length === 0, "the copy to be removed");
    });
});

type StubInvoke = (name: string, input: unknown, caller: Caller) => Promise<unknown>;

/** Serves the route over a bare HTTP server with a stubbed catalogue call; `closed` resolves when a response closes. */
async function serveRoute(
    invoke: StubInvoke,
): Promise<{ target: { host: string; port: number }; closed: Promise<void> }> {
    const route = createExportRoute({
        invoke,
        wayIn: "web interface",
        observe: () => ({}),
        logger: createLogger({ verbose: false, stream: { write: () => true } }),
    });
    const closed = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
        res.once("close", () => closed.resolve());
        void route(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { target: { host: "127.0.0.1", port: (server.address() as AddressInfo).port }, closed: closed.promise };
}

describe("the export route when the copy cannot be made", () => {
    it("answers with the error body, sends no file and leaves no copy", async () => {
        const daemon = await startExportDaemon();
        daemons.push(daemon);
        const stateDir = daemon.env.stateDir;
        const { target } = await serveRoute(async (name, input) => {
            if (name === "daemon.status") return { phase: "ready", instance: { stateDir } };
            await writeFile((input as { path: string }).path, "partial");
            throw new ServiceError("internal", "the copy failed");
        });

        const response = await startDownload(target);
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.resume();
        await new Promise((resolve) => response.once("end", resolve));

        assert.equal(response.statusCode, 500);
        assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
        assert.equal(JSON.parse(Buffer.concat(chunks).toString()).error.code, "internal");
        await waitFor(async () => (await downloads(stateDir)).length === 0, "the copy to be removed");
    });
});

describe("the export route when the client leaves before the copy exists", () => {
    it("leaves no copy although the response closed before the folder was made", async () => {
        const daemon = await startExportDaemon();
        daemons.push(daemon);
        const stateDir = daemon.env.stateDir;
        const statusGate = Promise.withResolvers<void>();
        const { target, closed } = await serveRoute(async (name, input) => {
            if (name === "daemon.status") {
                await statusGate.promise;
                return { phase: "ready", instance: { stateDir } };
            }
            await writeFile((input as { path: string }).path, "copy");
            return { path: (input as { path: string }).path, size: 4 };
        });
        const call = request({ ...target, method: "GET", path: "/export" });
        call.once("error", () => {});
        call.end();
        await waitFor(() => call.socket !== undefined && call.socket !== null, "the request to be sent");

        call.destroy();
        await closed;
        statusGate.resolve();

        await waitFor(
            async () => (await readdir(join(stateDir, "exports")).catch(() => ["none"])).length === 0,
            "the folder to be made and removed",
        );
    });
});
