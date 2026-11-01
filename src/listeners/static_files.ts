/**
 * The web interface files, served by the network listener (S-003 REQ-008). The Web interface spec owns their content;
 * this module only serves the folder.
 */
import { readFile, realpath } from "node:fs/promises";
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
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
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

/** Reads the file only when its real location, after symlinks, is still under the real root. */
async function sendFile(root: string, file: string, res: ServerResponse): Promise<boolean> {
    let content: Buffer;
    try {
        const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
        if (!isInside(realRoot, realFile)) return false;
        content = await readFile(realFile);
    } catch {
        return false;
    }
    res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? DEFAULT_CONTENT_TYPE,
        "content-length": content.length,
    });
    res.end(content);
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
        return file !== undefined && (await sendFile(base, file, res));
    };
}
