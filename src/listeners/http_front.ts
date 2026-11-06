import type { IncomingMessage, ServerResponse } from "node:http";
import type { Subscription } from "../feed/observation_feed.ts";
import {
    type Caller,
    type Catalogue,
    type ObservedDetails,
    ServiceError,
    type ServiceErrorCode,
} from "../service/operations.ts";
import { type ConversationSubscription, streamConversations, streamFeed } from "./feed_stream.ts";

export type WayIn = "command line" | "web interface";

export type FrontRequestContext = { signal: AbortSignal };

/** Answers a request the front has no route for; resolves true when it answered. */
export type Fallback = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type HttpFront = {
    handle(req: IncomingMessage, res: ServerResponse, ctx: FrontRequestContext): Promise<void>;
};

export type HttpFrontOptions = {
    catalogue: Catalogue;
    wayIn: WayIn;
    fallback?: Fallback;
    /** The caller details this listener observes for a request; none by default. */
    observe?: (req: IncomingMessage) => ObservedDetails;
};

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
const FEED_PATH = "/feed";
const SUBSCRIBE_OPERATION = "feed.subscribe";

type FeedSubscription = Subscription<unknown, { seq: number }>;
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

/**
 * The path and query of a request target. Node's parser accepts some targets the URL parser refuses; such a target
 * is kept as it is, with no query, so it matches no route and is still answered.
 */
function parseTarget(target: string): { pathname: string; query: URLSearchParams } {
    // A fixed base: the front never reads the Host header (S-003 REQ-014).
    if (!URL.canParse(target, "http://front.invalid")) return { pathname: target, query: new URLSearchParams() };
    const url = new URL(target, "http://front.invalid");
    return { pathname: url.pathname, query: url.searchParams };
}

function isFeedRoute(req: IncomingMessage, pathname: string): boolean {
    return req.method === "GET" && pathname === FEED_PATH;
}

type SubscribeInput = { scope: string; conversationId?: string };

function conversationIdOf(query: URLSearchParams): string {
    const id = query.get("id");
    if (!id)
        throw new ServiceError("invalid_input", "Query parameter id must name a conversation for scope conversation");
    return id;
}

/** The ids `scope=conversations` names, each once; none, or an empty one, is refused. */
function conversationIdsOf(query: URLSearchParams): string[] {
    const ids = query.getAll("id");
    if (ids.length === 0 || ids.includes(""))
        throw new ServiceError(
            "invalid_input",
            "Query parameter id must name every conversation of scope conversations",
        );
    return [...new Set(ids)];
}

/** The `feed.subscribe` inputs the query of `GET /feed` stands for, one per conversation of `scope=conversations`. */
function subscribeInputsOf(query: URLSearchParams): SubscribeInput[] {
    const scope = query.get("scope");
    if (scope === "instance") return [{ scope }];
    if (scope === "conversation") return [{ scope, conversationId: conversationIdOf(query) }];
    if (scope === "conversations")
        return conversationIdsOf(query).map((conversationId) => ({ scope: "conversation", conversationId }));
    throw new ServiceError(
        "invalid_input",
        `Query parameter scope must be "instance", "conversation" or "conversations", got ${scope ?? "none"}`,
    );
}

function operationNameOf(req: IncomingMessage, pathname: string): string | undefined {
    if (req.method !== "POST") return undefined;
    return OPERATION_ROUTE.exec(pathname)?.[1];
}

function refuseStreamOperation(name: string): void {
    if (!Object.hasOwn(STREAM_ROUTES, name)) return;
    throw new ServiceError("invalid_input", `Operation ${name} is a stream; call it at ${STREAM_ROUTES[name]}`);
}

function cutOff(name: string): ServiceError {
    return new ServiceError("unavailable", `Operation ${name} was cut off because the daemon is stopping`);
}

/**
 * Starts the operation unless the signal has aborted, then settles with its outcome, or rejects with `unavailable` as
 * soon as the signal aborts. The operation itself keeps running: the front only stops waiting for it (S-003 REQ-010).
 */
function runUntilAborted<T>(start: () => Promise<T>, signal: AbortSignal, name: string): Promise<T> {
    if (signal.aborted) return Promise.reject(cutOff(name));
    const operation = start();
    // The outcome of an abandoned operation has no reader; the catalogue logs unexpected failures itself.
    operation.catch(() => {});
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(cutOff(name));
    signal.addEventListener("abort", onAbort, { once: true });
    return Promise.race([operation, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

export function createHttpFront(options: HttpFrontOptions): HttpFront {
    function callerOf(req: IncomingMessage): Caller {
        const observed = options.observe?.(req);
        return {
            actor: observed
                ? { kind: "team_member", wayIn: options.wayIn, observed }
                : { kind: "team_member", wayIn: options.wayIn },
        };
    }

    async function callOperation(
        req: IncomingMessage,
        res: ServerResponse,
        name: string,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            refuseStreamOperation(name);
            const input = await readInput(req);
            const invoke = () => options.catalogue.invoke(name, input, callerOf(req));
            const result = await runUntilAborted(invoke, signal, name);
            sendJson(res, 200, { result });
        } catch (error) {
            // A refusal that leaves the body unread can't keep the connection for another request.
            if (!req.complete) res.shouldKeepAlive = false;
            sendError(res, asServiceError(error, name));
        }
    }

    /** Subscribes to each input; when one is refused, closes those already open and rethrows the first refusal. */
    async function subscribeAll(req: IncomingMessage, inputs: SubscribeInput[]): Promise<FeedSubscription[]> {
        const settled = await Promise.allSettled(
            inputs.map((input) => options.catalogue.invoke(SUBSCRIBE_OPERATION, input, callerOf(req))),
        );
        const opened = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
        const refused = settled.find((outcome) => outcome.status === "rejected");
        if (refused) {
            for (const subscription of opened) (subscription as FeedSubscription).close();
            throw refused.reason;
        }
        return opened as FeedSubscription[];
    }

    async function openFeed(
        req: IncomingMessage,
        res: ServerResponse,
        query: URLSearchParams,
        signal: AbortSignal,
    ): Promise<void> {
        let inputs: SubscribeInput[];
        let subscriptions: FeedSubscription[];
        try {
            inputs = subscribeInputsOf(query);
            subscriptions = await subscribeAll(req, inputs);
        } catch (error) {
            sendError(res, asServiceError(error, SUBSCRIBE_OPERATION));
            return;
        }
        if (query.get("scope") !== "conversations")
            return streamFeed(subscriptions[0] as FeedSubscription, res, signal);
        const named = subscriptions.map((subscription, index): ConversationSubscription => {
            return { conversationId: inputs[index]?.conversationId as string, subscription };
        });
        await streamConversations(named, res, signal);
    }

    async function answerUnrouted(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
        if (options.fallback && (await options.fallback(req, res))) return;
        if (!req.complete) res.shouldKeepAlive = false;
        sendError(res, new ServiceError("not_found", `No route for ${req.method} ${pathname}`));
    }

    return {
        async handle(req, res, ctx) {
            const { pathname, query } = parseTarget(req.url ?? "/");
            const name = operationNameOf(req, pathname);
            if (name !== undefined) await callOperation(req, res, name, ctx.signal);
            else if (isFeedRoute(req, pathname)) await openFeed(req, res, query, ctx.signal);
            else await answerUnrouted(req, res, pathname);
        },
    };
}
