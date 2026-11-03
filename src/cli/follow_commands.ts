/**
 * `bob follow` (S-005 REQ-007, REQ-015): prints the instance feed until Ctrl-C. It follows through `followFeed`, so it
 * keeps going across daemon restarts and lag. Imports the client library only, never the daemon.
 */
import { createClient } from "../client/client.ts";
import { nodeTransport } from "../client/node_transport.ts";
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { socketPathFor } from "./connection.ts";
import { followFeed } from "./feed_follower.ts";
import { instanceEventLine } from "./feed_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";

const FOLLOWING_HINT = "Following the instance feed; press Ctrl-C to stop";

async function follow(input: CommandInput): Promise<number> {
    const { io, json } = input;
    const socketPath = socketPathFor(input);
    const stop = new AbortController();
    const requestStop = () => stop.abort();
    process.once("SIGINT", requestStop);
    try {
        await followFeed({
            connect: () => createClient(nodeTransport({ socketPath })),
            scope: { scope: "instance" },
            signal: stop.signal,
            onNotice: (text) => writeError(io, text),
            async onSnapshot(snapshot) {
                if (json) writeJson(io, snapshot);
                writeError(io, FOLLOWING_HINT);
            },
            async onDelta(delta) {
                if (json) {
                    writeJson(io, delta);
                    return;
                }
                const line = instanceEventLine(delta);
                if (line !== undefined) writeLine(io, line);
            },
        });
    } finally {
        process.off("SIGINT", requestStop);
    }
    return EXIT_CODES.ok;
}

export const followCommand: CommandSpec = {
    verb: "follow",
    summary: "Print the instance feed until Ctrl-C.",
    positionals: [],
    options: {},
    isData: true,
    callsService: true,
    run: follow,
};
