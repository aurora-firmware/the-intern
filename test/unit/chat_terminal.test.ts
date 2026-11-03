/**
 * The terminal chat with a scripted client (S-005 REQ-015, AC-015.1): a catch-up read that meets a daemon going away
 * doesn't end the chat; the next snapshot reads again.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runTerminalChat } from "../../src/cli/chat_terminal.ts";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { type Client, UnreachableError } from "../../src/client/client.ts";

const DESK_ID = "desk-1";

function terminalIo(): CommandIo {
    return {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        env: {},
        cwd: "/",
        homeDir: "/",
        isStdoutTerminal: true,
        isStdinTerminal: true,
    };
}

/** Its entries reads after the history read fail as an unreachable daemon the first `failures` times. */
function clientWithFailingCatchUp(failures: number) {
    let entriesReads = 0;
    const client: Client = {
        async invoke(name) {
            if (name === "desk.get") return { conversationId: DESK_ID };
            entriesReads++;
            if (entriesReads > 1 && entriesReads <= 1 + failures) throw new UnreachableError("/run/bob.sock", "gone");
            return { entries: [] };
        },
        subscribe: async function* () {
            yield { snapshot: "s" };
            await new Promise<never>(() => {});
            return { end: "unsubscribed" };
        },
    };
    return { client, entriesReads: () => entriesReads };
}

describe("runTerminalChat", () => {
    it("keeps_running_and_exits_ok_when_a_catch_up_read_finds_the_daemon_unreachable", async () => {
        const io = terminalIo();
        const script = clientWithFailingCatchUp(1);
        const finished = runTerminalChat(() => script.client, io, { reset: false, json: false });
        const outcome = await Promise.race([
            finished,
            new Promise<string>((resolve) => setTimeout(() => resolve("running"), 200)),
        ]);
        assert.equal(outcome, "running");
        assert.ok(script.entriesReads() >= 2, "the failing catch-up read ran");

        (io.stdin as PassThrough).end();

        assert.equal(await finished, 0);
    });
});
