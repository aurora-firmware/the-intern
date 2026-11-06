/**
 * The web interface files, served by the network listener (S-003 REQ-008). The Web interface spec owns their content;
 * this module only serves the folder and the four addresses outside it (ADR-006 decision 4). A `.ts` file is served
 * with its types stripped, so the pages need no build step.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fallback } from "./http_front.ts";

export const WEB_UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "ui");

const UI_PREFIX = "/ui/";
const INDEX_FILE = "index.html";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".ts": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** The path of a request target, or undefined when the target cannot be parsed. */
function pathnameOf(target: string): string | undefined {
    // A fixed base: the Host header is never read (S-003 REQ-014).
    if (!URL.canParse(target, "http://front.invalid")) return undefined;
    return new URL(target, "http://front.invalid").pathname;
}

/** The file a `/ui/` path names under the root; undefined when it leaves the root or cannot be decoded. */
function fileUnder(root: string, pathname: string): string | undefined {
    let relativePath: string;
    try {
        relativePath = decodeURIComponent(pathname.slice(UI_PREFIX.length));
    } catch {
        return undefined;
    }
    if (relativePath.includes("\0")) return undefined;
    const file = resolve(
        root,
        relativePath === "" || relativePath.endsWith("/") ? join(relativePath, INDEX_FILE) : relativePath,
    );
    return isInside(root, file) ? file : undefined;
}

function isInside(root: string, file: string): boolean {
    const inside = relative(root, file);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The four addresses outside `web/ui/` and the files they name (ADR-006 decision 4). */
const OUTSIDE_FILES: Readonly<Record<string, string>> = {
    "/ui/client/client.ts": join(SOURCE_ROOT, "client", "client.ts"),
    "/ui/client/browser_transport.ts": join(SOURCE_ROOT, "client", "browser_transport.ts"),
    "/ui/vendor/preact.mjs": fileURLToPath(import.meta.resolve("preact")),
    "/ui/vendor/hooks.mjs": fileURLToPath(import.meta.resolve("preact/hooks")),
};

type Served = { body: Buffer; etag: string };
type Cached = Served & { mtimeMs: number; size: number };

type Stripper = (code: string, options: { mode: "strip-only" }) => { code: string };

/** The stripped text of each `.ts` file, kept while its modification time and size stay the same. */
const strippedFiles = new Map<string, Cached>();

let stripper: Promise<Stripper> | undefined;

/** Loads `amaro` at the first `.ts` request, because no daemon code loads for a command (ADR-005). */
function loadStripper(): Promise<Stripper> {
    stripper ??= import("amaro").then((amaro) => amaro.transformSync);
    return stripper;
}

function etagOf(body: Buffer): string {
    return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

/** A `.ts` file that `amaro` cannot strip, or that `amaro` itself cannot load. */
class StripError extends Error {}

async function stripTypes(code: Buffer): Promise<Buffer> {
    try {
        const transformSync = await loadStripper();
        return Buffer.from(transformSync(code.toString("utf8"), { mode: "strip-only" }).code);
    } catch (error) {
        throw new StripError("The file cannot be stripped of its types", { cause: error });
    }
}

async function readServed(file: string): Promise<Served> {
    const { mtimeMs, size } = await stat(file);
    const isTypeScript = extname(file).toLowerCase() === ".ts";
    const cached = strippedFiles.get(file);
    if (isTypeScript && cached?.mtimeMs === mtimeMs && cached.size === size) return cached;
    const content = await readFile(file);
    const body = isTypeScript ? await stripTypes(content) : content;
    const served = { body, etag: etagOf(body) };
    if (isTypeScript) strippedFiles.set(file, { ...served, mtimeMs, size });
    return served;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
    if (header === undefined) return false;
    return header.split(",").some((candidate) => {
        const value = candidate.trim();
        return value === "*" || value.replace(/^W\//, "") === etag;
    });
}

function sendInternalError(res: ServerResponse): void {
    const text = JSON.stringify({ error: { code: "internal", message: "The file could not be prepared for serving" } });
    res.writeHead(500, {
        "cache-control": "no-cache",
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
    });
    res.end(text);
}

/** The file to read: a table file as is, any other only when its real location, after symlinks, is under the root. */
async function locate(root: string, file: string, pathname: string): Promise<string | undefined> {
    const tableFile = OUTSIDE_FILES[pathname];
    if (tableFile !== undefined) return tableFile;
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    return isInside(realRoot, realFile) ? realFile : undefined;
}

async function sendFile(root: string, file: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let served: Served;
    let path: string;
    try {
        const located = await locate(root, file, pathnameOf(req.url ?? "/") ?? "");
        if (located === undefined) return false;
        path = located;
        served = await readServed(path);
    } catch (error) {
        if (!(error instanceof StripError)) return false;
        sendInternalError(res);
        return true;
    }
    const headers = { "cache-control": "no-cache", etag: served.etag };
    if (matchesEtag(req.headers["if-none-match"], served.etag)) {
        res.writeHead(304, headers);
        res.end();
        return true;
    }
    res.writeHead(200, {
        ...headers,
        "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? DEFAULT_CONTENT_TYPE,
        "content-length": served.body.length,
    });
    res.end(served.body);
    return true;
}

/** Answers `GET /` with a redirect to `/ui/` and `GET /ui/<path>` with the file under `root`; declines the rest. */
export function createStaticFiles(root: string): Fallback {
    const base = resolve(root);
    return async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET") return false;
        const pathname = pathnameOf(req.url ?? "/");
        if (pathname === "/") {
            res.writeHead(302, { location: UI_PREFIX, "content-length": 0 });
            res.end();
            return true;
        }
        if (pathname === undefined || !pathname.startsWith(UI_PREFIX)) return false;
        const file = fileUnder(base, pathname);
        return file !== undefined && (await sendFile(base, file, req, res));
    };
}
