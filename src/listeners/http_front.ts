import type { IncomingMessage, ServerResponse } from "node:http";
import { type Caller, type Catalogue, ServiceError, type ServiceErrorCode } from "../service/operations.ts";

export type WayIn = "command line" | "web interface";

export type FrontRequestContext = { signal: AbortSignal };

/** Answers a request the front has no route for; resolves true when it answered. */
export type Fallback = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type HttpFront = {
    handle(req: IncomingMessage, res: ServerResponse, ctx: FrontRequestContext): Promise<void>;
};

export type HttpFrontOptions = { catalogue: Catalogue; wayIn: WayIn; fallback?: Fallback };

export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
    invalid_input: 400,
    not_found: 404,
    busy: 409,
    conflict: 409,
    unavailable: 503,
    internal: 500,
};

/** Operations whose result is a stream, and the route that serves each one instead of the operation route. */
export const STREAM_ROUTES: Readonly<Record<string, string>> = Object.freeze({ "feed.subscribe": "GET /feed" });

const OPERATION_ROUTE = /^\/operations\/([^/]+)$/;
const JSON_MEDIA_TYPE = "application/json";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
    });
    res.end(text);
}

function sendError(res: ServerResponse, error: ServiceError): void {
    sendJson(res, STATUS_BY_CODE[error.code], { error: { code: error.code, message: error.message } });
}

function asServiceError(error: unknown, operationName: string): ServiceError {
    if (error instanceof ServiceError) return error;
    return new ServiceError("internal", `Operation ${operationName} failed unexpectedly`);
}

function isJsonMediaType(contentType: string | undefined): boolean {
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
    return mediaType === JSON_MEDIA_TYPE;
}

function tooLarge(): ServiceError {
    return new ServiceError("invalid_input", `Request body is larger than the limit of ${MAX_BODY_BYTES} bytes`);
}

/**
 * Reads the body up to MAX_BODY_BYTES. A larger body is refused as soon as the limit is passed, and the rest is left
 * unread: the request is paused rather than destroyed, so the refusal can still be sent on the connection.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
    const declaredLength = Number(req.headers["content-length"]);
    if (declaredLength > MAX_BODY_BYTES) return Promise.reject(tooLarge());

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        function stopReading(): void {
            req.off("data", onData);
            req.off("end", onEnd);
            req.off("error", onError);
            req.pause();
        }
        function onData(chunk: Buffer): void {
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_BODY_BYTES) {
                stopReading();
                reject(tooLarge());
                return;
            }
            chunks.push(chunk);
        }
        function onEnd(): void {
            stopReading();
            resolve(Buffer.concat(chunks));
        }
        function onError(error: Error): void {
            stopReading();
            reject(new ServiceError("invalid_input", `Request body could not be read: ${error.message}`));
        }
        req.on("data", onData);
        req.on("end", onEnd);
        req.on("error", onError);
    });
}

function parseInput(body: Buffer): unknown {
    if (body.length === 0) return undefined;
    try {
        return JSON.parse(body.toString("utf8"));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ServiceError("invalid_input", `Request body is not valid JSON: ${reason}`);
    }
}

async function readInput(req: IncomingMessage): Promise<unknown> {
    if (!isJsonMediaType(req.headers["content-type"])) {
        throw new ServiceError(
            "invalid_input",
            `Request must declare the ${JSON_MEDIA_TYPE} content type, got ${req.headers["content-type"] ?? "none"}`,
        );
    }
    return parseInput(await readBody(req));
}

function operationNameOf(req: IncomingMessage, pathname: string): string | undefined {
    if (req.method !== "POST") return undefined;
    return OPERATION_ROUTE.exec(pathname)?.[1];
}

function refuseStreamOperation(name: string): void {
    if (!Object.hasOwn(STREAM_ROUTES, name)) return;
    throw new ServiceError("invalid_input", `Operation ${name} is a stream; call it at ${STREAM_ROUTES[name]}`);
}

export function createHttpFront(options: HttpFrontOptions): HttpFront {
    const caller: Caller = { actor: { kind: "team_member", wayIn: options.wayIn } };

    async function callOperation(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
        try {
            refuseStreamOperation(name);
            const input = await readInput(req);
            const result = await options.catalogue.invoke(name, input, caller);
            sendJson(res, 200, { result });
        } catch (error) {
            // A refusal that leaves the body unread can't keep the connection for another request.
            if (!req.complete) res.shouldKeepAlive = false;
            sendError(res, asServiceError(error, name));
        }
    }

    async function answerUnrouted(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
        if (options.fallback && (await options.fallback(req, res))) return;
        if (!req.complete) res.shouldKeepAlive = false;
        sendError(res, new ServiceError("not_found", `No route for ${req.method} ${pathname}`));
    }

    return {
        async handle(req, res) {
            // A fixed base: the front never reads the Host header (S-003 REQ-014).
            const pathname = new URL(req.url ?? "/", "http://front.invalid").pathname;
            const name = operationNameOf(req, pathname);
            if (name === undefined) await answerUnrouted(req, res, pathname);
            else await callOperation(req, res, name);
        },
    };
}
