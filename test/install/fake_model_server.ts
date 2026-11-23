import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the server shows a script of one model request: the messages after the system message, oldest first. */
export type ScriptMessage = { role: "user" | "assistant" | "toolResult"; text: string };

export type ScriptReply = string | { toolCall: { name: string; arguments: Record<string, unknown> } };

/** A reply script is a pure function of the transcript: the same transcript always gets the same reply. */
export type ReplyScript = (transcript: readonly ScriptMessage[]) => ScriptReply;

export type FakeModelServer = {
    /** The base URL of the server's OpenAI-style API, with its `/v1` prefix. */
    baseUrl: string;
    /** The transcripts of the requests received so far, in the order they arrived. */
    requests(): readonly (readonly ScriptMessage[])[];
    /** Ends open streams and stops listening. */
    close(): Promise<void>;
};

export const MODEL_ID = "plain-model";
export const SLOW_TOOL_COMMAND = "sleep 3600";
export const JOB_DONE_DEFINITION = "The request is answered.";
const LOOPBACK = "127.0.0.1";

const toolResultCount = (transcript: readonly ScriptMessage[]): number =>
    transcript.filter((message) => message.role === "toolResult").length;

/** Sets a definition of done, completes the job, then says it is finished: the job reaches Done in three requests. */
export const defaultScript: ReplyScript = (transcript) => {
    const results = toolResultCount(transcript);
    if (results === 0) {
        return { toolCall: { name: "update_job", arguments: { definitionOfDone: JOB_DONE_DEFINITION } } };
    }
    if (results === 1) {
        return { toolCall: { name: "complete_job", arguments: { justification: "The request is answered." } } };
    }
    return "The job is done.";
};

/** Keeps the lead in a `bash` call that ends only when the call is aborted, such as when the daemon stops. */
export const slowScript: ReplyScript = (transcript) => {
    if (toolResultCount(transcript) === 0) {
        return { toolCall: { name: "bash", arguments: { command: SLOW_TOOL_COMMAND } } };
    }
    return "The slow command ended.";
};

type ChatMessage = { role: string; content?: unknown };

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

function transcriptOf(messages: readonly ChatMessage[]): ScriptMessage[] {
    return messages.flatMap((message): ScriptMessage[] => {
        const text = textOf(message.content);
        if (message.role === "user" || message.role === "assistant") return [{ role: message.role, text }];
        if (message.role === "tool") return [{ role: "toolResult", text }];
        return [];
    });
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function chunkOf(transcript: readonly ScriptMessage[], delta: object, finishReason: string | null): string {
    const chunk = {
        id: `chatcmpl-${transcript.length}`,
        object: "chat.completion.chunk",
        created: 0,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(finishReason !== null && { usage: USAGE }),
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

function streamOf(transcript: readonly ScriptMessage[], reply: ScriptReply): string {
    if (typeof reply === "string") {
        const text = chunkOf(transcript, { role: "assistant", content: reply }, null);
        return `${text}${chunkOf(transcript, {}, "stop")}data: [DONE]\n\n`;
    }
    const call = {
        index: 0,
        id: `call_${transcript.length}`,
        type: "function",
        function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) },
    };
    const opening = chunkOf(transcript, { role: "assistant", tool_calls: [call] }, null);
    return `${opening}${chunkOf(transcript, {}, "tool_calls")}data: [DONE]\n\n`;
}

async function answer(
    request: IncomingMessage,
    response: ServerResponse,
    script: ReplyScript,
    seen: (readonly ScriptMessage[])[],
): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
    }
    const body = JSON.parse(await readBody(request)) as { messages: ChatMessage[] };
    const transcript = transcriptOf(body.messages);
    seen.push(transcript);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(streamOf(transcript, script(transcript)));
}

/** Starts an OpenAI-style chat completions server on the loopback, on a port the system picks. */
export async function startFakeModelServer(script: ReplyScript = defaultScript): Promise<FakeModelServer> {
    const seen: (readonly ScriptMessage[])[] = [];
    const server: Server = createServer((request, response) => {
        answer(request, response, script, seen).catch((error: unknown) => {
            response.writeHead(500).end(String(error));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://${LOOPBACK}:${port}/v1`,
        requests: () => seen,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
