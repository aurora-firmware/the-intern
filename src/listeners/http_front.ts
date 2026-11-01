import type { IncomingMessage, ServerResponse } from "node:http";
import type { Caller, Catalogue } from "../service/operations.ts";

export type WayIn = "command line" | "web interface";

export type FrontRequestContext = { signal: AbortSignal };

/** Answers a request the front has no route for; resolves true when it answered. */
export type Fallback = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type HttpFront = {
    handle(req: IncomingMessage, res: ServerResponse, ctx: FrontRequestContext): Promise<void>;
};

export type HttpFrontOptions = { catalogue: Catalogue; wayIn: WayIn; fallback?: Fallback };

const OPERATION_ROUTE = /^\/operations\/([^/]+)$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
    });
    res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

export function createHttpFront(options: HttpFrontOptions): HttpFront {
    const caller: Caller = { actor: { kind: "team_member", wayIn: options.wayIn } };

    return {
        async handle(req, res) {
            const pathname = new URL(req.url ?? "/", "http://front.invalid").pathname;
            const match = OPERATION_ROUTE.exec(pathname);
            const name = match?.[1] ?? "";
            const body = await readBody(req);
            const input = body.length === 0 ? undefined : JSON.parse(body.toString("utf8"));
            const result = await options.catalogue.invoke(name, input, caller);
            sendJson(res, 200, { result });
        },
    };
}
