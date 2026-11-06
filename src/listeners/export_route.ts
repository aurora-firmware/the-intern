/**
 * The export route `GET /export` of the network listener (S-003 REQ-016; ADR-001 decision 2): a consistent copy of the
 * whole database, made by `jobs.export` through the catalogue into a folder of its own under the state directory's
 * `exports` folder, then sent as a file attachment. The route adds no operation and imports nothing of the host.
 */

import { mkdir, mkdtemp, open, rm, stat, statfs } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";
import type { Logger } from "../daemon/logger.ts";
import { resolveInstanceDirs } from "../daemon/state_layout.ts";
import { type Caller, type Catalogue, type ObservedDetails, ServiceError } from "../service/operations.ts";
import { type Fallback, STATUS_BY_CODE, type WayIn } from "./http_front.ts";

const EXPORT_PATH = "/export";
const EXPORTS_FOLDER = "exports";
const OWNER_ONLY_FOLDER_MODE = 0o700;
const COPY_FILE_NAME = "export.sqlite";
const SQLITE_MEDIA_TYPE = "application/vnd.sqlite3";
const ISO_DATE_LENGTH = 10;
const NOT_NAME_CHARACTERS = /[^A-Za-z0-9._-]/g;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

/** Room kept beyond the copy for what running jobs write while the file downloads (architecture.md, The export route). */
export const EXPORT_FREE_SPACE_MARGIN_BYTES = 256 * BYTES_PER_MEBIBYTE;

export type ExportRouteOptions = {
    /** The catalogue call the route makes; the network listener passes the catalogue's own. */
    invoke: Catalogue["invoke"];
    wayIn: WayIn;
    /** The TCP peer's address and port. */
    observe(req: IncomingMessage): ObservedDetails;
    logger: Logger;
    /** Test-only: the free bytes of the file system holding the folder; `statfs` by default. */
    readFreeSpace?: (folder: string) => Promise<number>;
};

type Instance = { configDir: string; stateDir: string; dataDir: string; runtimeDir: string };
type Status = { phase: string; instance: Instance };
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

async function freeBytesOf(folder: string): Promise<number> {
    const info = await statfs(folder);
    return info.bavail * info.bsize;
}

async function sizeIfPresent(path: string): Promise<number> {
    try {
        return (await stat(path)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
}

/** Refuses when the folder's file system could not hold the database, its `-wal` file and the margin. */
async function requireFreeSpace(options: ExportRouteOptions, exportsFolder: string, instance: Instance): Promise<void> {
    const { databaseFile } = resolveInstanceDirs({ flags: instance, env: {}, homeDir: instance.stateDir });
    const databaseBytes = await sizeIfPresent(databaseFile);
    const walBytes = await sizeIfPresent(`${databaseFile}-wal`);
    const needed = databaseBytes + walBytes + EXPORT_FREE_SPACE_MARGIN_BYTES;
    const free = await (options.readFreeSpace ?? freeBytesOf)(exportsFolder);
    if (free < needed) {
        throw new ServiceError(
            "conflict",
            `The export needs ${needed} bytes free (the database ${databaseBytes}, its write-ahead log ${walBytes} and a margin of ${EXPORT_FREE_SPACE_MARGIN_BYTES}), and ${free} are free`,
        );
    }
}

/** Checks the daemon is ready and has room, then makes the owner-only folder for one download. */
async function makeFolder(options: ExportRouteOptions, caller: Caller): Promise<{ folder: string; stateDir: string }> {
    const status = (await options.invoke("daemon.status", {}, caller)) as Status;
    if (status.phase !== "ready") {
        throw new ServiceError("unavailable", `The export is unavailable while the daemon is ${status.phase}`);
    }
    const stateDir = status.instance.stateDir;
    const exportsFolder = join(stateDir, EXPORTS_FOLDER);
    await mkdir(exportsFolder, { recursive: true, mode: OWNER_ONLY_FOLDER_MODE });
    await requireFreeSpace(options, exportsFolder, status.instance);
    return { folder: await mkdtemp(join(exportsFolder, "download-")), stateDir };
}

/** Runs `action` once the response has closed, at once when it already has. */
function whenClosed(res: ServerResponse, action: () => void): void {
    if (res.closed) action();
    else res.once("close", action);
}

/**
 * The one place the temporary copy goes: the response's close follows every ending, finished, failed or abandoned.
 * A client that left while the folder was being made has closed the response already, so the folder goes at once.
 */
function removeWhenClosed(res: ServerResponse, folder: string, logger: Logger): void {
    whenClosed(res, () => {
        rm(folder, { recursive: true, force: true }).catch((error: unknown) => {
            logger.error("export copy not removed", { folder, error: describeError(error) });
        });
    });
}

/** Creates the route as a fallback of the HTTP front: it answers `GET /export` and declines every other request. */
export function createExportRoute(options: ExportRouteOptions): Fallback {
    // The one download slot, in memory: taken before anything else, freed when the response closes (ADR-001 decision 2).
    let isSlotTaken = false;
    return async (req, res) => {
        if (!isExportRequest(req)) return false;
        if (isSlotTaken) {
            sendError(
                res,
                new ServiceError("busy", "Another export download is running; try again when it ends"),
                options.logger,
            );
            return true;
        }
        isSlotTaken = true;
        whenClosed(res, () => {
            isSlotTaken = false;
        });
        try {
            const observed = options.observe(req);
            const caller: Caller = { actor: { kind: "team_member", wayIn: options.wayIn, observed } };
            const { folder, stateDir } = await makeFolder(options, caller);
            removeWhenClosed(res, folder, options.logger);
            if (res.closed) return true;
            const copy = (await options.invoke("jobs.export", { path: join(folder, COPY_FILE_NAME) }, caller)) as Copy;
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
