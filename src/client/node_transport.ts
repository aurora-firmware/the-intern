/**
 * The client library's Node transport (S-003 REQ-009): calls and feed streams over `node:http`, to the daemon's local
 * socket or to a base URL.
 */
import { type ClientRequest, type IncomingMessage, type RequestOptions, request } from "node:http";
import { resolveInstanceDirs } from "../daemon/state_layout.ts";
import { localSocketPath } from "../listeners/socket_path.ts";
import {
    answerError,
    encodeInput,
    JSON_CONTENT_TYPE,
    operationPath,
    parseEventStream,
    type StreamEvent,
    type Transport,
} from "./client.ts";

export type NodeTarget = { socketPath: string } | { baseUrl: string };

export type DefaultSocketOptions = { env: NodeJS.ProcessEnv; homeDir: string; runtimeDir?: string };

/** The socket the daemon of this instance listens on, its runtime directory resolved as the daemon resolves it. */
export function defaultSocketPath(options: DefaultSocketOptions): string {
    const { env, homeDir, runtimeDir } = options;
    return localSocketPath(resolveInstanceDirs({ flags: { runtimeDir }, env, homeDir }).runtimeDir);
}

function describeTarget(target: NodeTarget): string {
    return "socketPath" in target ? target.socketPath : target.baseUrl;
}

/** Opens a request on the target; one connection per request, so no idle connection outlives it. */
function openRequest(target: NodeTarget, options: RequestOptions & { path: string }): ClientRequest {
    if ("socketPath" in target) return request({ ...options, socketPath: target.socketPath, agent: false });
    return request(new URL(options.path, target.baseUrl), { ...options, agent: false });
}

/** Sends the request and resolves with the response. */
function responseOf(req: ClientRequest, body: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        req.once("response", resolve);
        // Kept for the request's whole life: an error after the response must not go unhandled.
        req.on("error", reject);
        req.end(body);
    });
}

/** The response's text chunks. */
async function* chunksOf(response: IncomingMessage): AsyncIterable<string> {
    response.setEncoding("utf8");
    for await (const chunk of response) yield chunk as string;
}

/** Reads the whole response body. */
async function readText(response: IncomingMessage): Promise<string> {
    let text = "";
    for await (const chunk of chunksOf(response)) text += chunk;
    return text;
}

function parseAnswer(text: string, status: number | undefined, target: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`The answer from ${target} is not JSON (status ${status}): ${text.slice(0, 200)}`);
    }
}

/** Opens the feed route and yields its events; the request is closed when the reader stops or the stream ends. */
async function* streamEvents(target: NodeTarget, described: string, path: string): AsyncIterable<StreamEvent> {
    const req = openRequest(target, { method: "GET", path });
    try {
        const response = await responseOf(req, "");
        if (response.statusCode !== 200) {
            throw answerError(parseAnswer(await readText(response), response.statusCode, described));
        }
        yield* parseEventStream(chunksOf(response));
    } finally {
        req.destroy();
    }
}

export function nodeTransport(target: NodeTarget): Transport {
    const described = describeTarget(target);
    return {
        async call(name, input) {
            const body = encodeInput(input);
            const headers = { "content-type": JSON_CONTENT_TYPE, "content-length": Buffer.byteLength(body) };
            const req = openRequest(target, { method: "POST", path: operationPath(name), headers });
            try {
                const response = await responseOf(req, body);
                return parseAnswer(await readText(response), response.statusCode, described);
            } finally {
                req.destroy();
            }
        },
        stream: (path) => streamEvents(target, described, path),
    };
}
