/**
 * The export route `GET /export` of the network listener (S-003 REQ-016; ADR-001 decision 2): a consistent copy of the
 * whole database, made by `jobs.export` through the catalogue into a folder of its own under the state directory's
 * `exports` folder, then sent as a file attachment. The route adds no operation and imports nothing of the host.
 */

import { mkdir, mkdtemp, open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";
import type { Logger } from "../daemon/logger.ts";
import { type Caller, type Catalogue, type ObservedDetails, ServiceError } from "../service/operations.ts";
import { type Fallback, STATUS_BY_CODE, type WayIn } from "./http_front.ts";

const EXPORT_PATH = "/export";
const EXPORTS_FOLDER = "exports";
const OWNER_ONLY_FOLDER_MODE = 0o700;
const COPY_FILE_NAME = "export.sqlite";
const SQLITE_MEDIA_TYPE = "application/vnd.sqlite3";
const ISO_DATE_LENGTH = 10;
const NOT_NAME_CHARACTERS = /[^A-Za-z0-9._-]/g;

export type ExportRouteOptions = {
    /** The catalogue call the route makes; the network listener passes the catalogue's own. */
    invoke: Catalogue["invoke"];
    wayIn: WayIn;
    /** The TCP peer's address and port. */
    observe(req: IncomingMessage): ObservedDetails;
    logger: Logger;
};

type Status = { phase: string; instance: { stateDir: string } };
type Copy = { path: string; size: number };

function isExportRequest(req: IncomingMessage): boolean {
    if (req.method !== "GET") return false;
    if (!URL.canParse(req.url ?? "/", "http://front.invalid")) return false;
    return new URL(req.url ?? "/", "http://front.invalid").pathname === EXPORT_PATH;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A refusal from the catalogue goes out as it is; any other failure is logged with its cause, since the catalogue never saw it. */
function sendError(res: ServerResponse, error: unknown, logger: Logger): void {
    if (!(error instanceof ServiceError)) logger.error("export failed", { error: describeError(error) });
    const known =
        error instanceof ServiceError
            ? error
            : new ServiceError("internal", "The export could not be made; the daemon's log names the cause");
    const text = JSON.stringify({ error: { code: known.code, message: known.message } });
    res.writeHead(STATUS_BY_CODE[known.code], {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
    });
    res.end(text);
}

/** The state directory's last folder, keeping only letters, digits, `.`, `-` and `_`. */
function instanceName(stateDir: string): string {
    const last =
        stateDir
            .split("/")
            .filter((part) => part !== "")
            .pop() ?? "";
    return last.replace(NOT_NAME_CHARACTERS, "");
}

function fileNameOf(stateDir: string): string {
    const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
    return `the-intern-${instanceName(stateDir)}-${date}.sqlite`;
}

async function makeCopy(options: ExportRouteOptions, caller: Caller): Promise<{ copy: Copy; stateDir: string }> {
    const status = (await options.invoke("daemon.status", {}, caller)) as Status;
    if (status.phase !== "ready") {
        throw new ServiceError("unavailable", `The export is unavailable while the daemon is ${status.phase}`);
    }
    const stateDir = status.instance.stateDir;
    const exportsFolder = join(stateDir, EXPORTS_FOLDER);
    await mkdir(exportsFolder, { recursive: true, mode: OWNER_ONLY_FOLDER_MODE });
    const folder = await mkdtemp(join(exportsFolder, "download-"));
    const copy = (await options.invoke("jobs.export", { path: join(folder, COPY_FILE_NAME) }, caller)) as Copy;
    return { copy, stateDir };
}

/** Creates the route as a fallback of the HTTP front: it answers `GET /export` and declines every other request. */
export function createExportRoute(options: ExportRouteOptions): Fallback {
    return async (req, res) => {
        if (!isExportRequest(req)) return false;
        try {
            const observed = options.observe(req);
            const caller: Caller = { actor: { kind: "team_member", wayIn: options.wayIn, observed } };
            const { copy, stateDir } = await makeCopy(options, caller);
            const file = await open(copy.path);
            options.logger.info("export download", {
                wayIn: options.wayIn,
                remoteAddress: observed.remoteAddress ?? "",
                remotePort: observed.remotePort ?? 0,
            });
            res.writeHead(200, {
                "content-type": SQLITE_MEDIA_TYPE,
                "content-disposition": `attachment; filename="${fileNameOf(stateDir)}"`,
                "content-length": copy.size,
            });
            // A failure after the first byte destroys the response, which closes the connection short of its length.
            pipeline(file.createReadStream(), res, (failure) => {
                if (failure) options.logger.error("export download cut short", { error: describeError(failure) });
            });
        } catch (error) {
            sendError(res, error, options.logger);
        }
        return true;
    };
}
