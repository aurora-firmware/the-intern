/**
 * The terminal chat with a scripted client (S-005 REQ-015, AC-015.1): a catch-up read that meets a daemon going away
 * doesn't end the chat; the next snapshot reads again. And what the chat puts on the screen of an answer that is still
 * being written (REQ-009): the partial as it grows, once, whatever the feed does around it.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { runTerminalChat } from "../../src/cli/chat_terminal.ts";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { type Client, UnreachableError } from "../../src/client/client.ts";
import { renderTerminal } from "../support/screen_renderer.ts";

const DESK_ID = "desk-1";
const SCREEN_COLUMNS = 40;

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

type Entry = { id: string; kind: string; data: unknown };

const answerEntry = (id: string, text: string, timestamp: number): Entry => ({
    id,
    kind: "pi.assistant",
    data: [{ role: "assistant", content: [{ type: "text", text }], timestamp }],
});

const liveWith = (content: unknown[], timestamp: number) => ({
    run: { taskId: 1, inputs: [1] },
    generation: { attempt: 1, message: { role: "assistant", content, stopReason: "pending", timestamp } },
});

const openChats: PassThrough[] = [];

// A test that fails before it leaves must not keep the chat, and so the run, alive.
afterEach(() => {
    for (const stdin of openChats.splice(0)) stdin.end();
});

/** A chat on a feed the test feeds by hand; `entries` is what `conversations.entries` returns. */
function chatOnScriptedFeed() {
    const entries: Entry[] = [];
    const queue: unknown[] = [];
    let wake = () => {};
    const client: Client = {
        async invoke(name) {
            if (name === "desk.get") return { conversationId: DESK_ID };
            if (name === "conversations.submit") return { submissionId: "s-1" };
            if (name === "submissions.wait") return { state: "done" };
            return { entries: [...entries] };
        },
        subscribe: async function* () {
            for (;;) {
                while (queue.length > 0) yield queue.shift() as never;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
    const io = terminalIo();
    Object.assign(io.stdout, { columns: SCREEN_COLUMNS });
    let screen = "";
    io.stdout.on("data", (chunk) => {
        screen += chunk;
    });
    openChats.push(io.stdin as PassThrough);
    const finished = runTerminalChat(() => client, io, { reset: false, json: false });
    return {
        entries,
        finished,
        screen: () => screen,
        /** What a terminal shows after the bytes written so far. */
        rendered: () => renderTerminal(screen, { columns: SCREEN_COLUMNS }).rows,
        type(keys: string) {
            (io.stdin as PassThrough).write(keys);
        },
        async seeRow(text: string) {
            const deadline = Date.now() + 5000;
            while (!renderTerminal(screen, { columns: SCREEN_COLUMNS }).rows.includes(text)) {
                assert.ok(Date.now() < deadline, `timed out waiting for the row ${JSON.stringify(text)} in ${screen}`);
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        },
        feed(item: unknown) {
            queue.push(item);
            wake();
        },
        async see(text: string) {
            const deadline = Date.now() + 5000;
            while (!screen.includes(text)) {
                assert.ok(Date.now() < deadline, `timed out waiting for ${JSON.stringify(text)} in ${screen}`);
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        },
        async leave() {
            (io.stdin as PassThrough).end();
            assert.equal(await finished, 0);
        },
    };
}

describe("runTerminalChat on a feed with a partial answer", () => {
    it("prints the partial as it grows and the rest of the answer when its entry lands, each text once", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });

        chat.feed({ seq: 1, delta: { seq: 1, view: { live: liveWith([{ type: "text", text: "two are" }], 7) } } });
        await chat.see("two are");
        chat.feed({
            seq: 2,
            delta: { seq: 2, view: { live: liveWith([{ type: "text", text: "two are blocked" }], 7) } },
        });
        await chat.see("two are blocked");
        chat.entries.push(answerEntry("e1", "two are blocked and one is late", 7));
        chat.feed({ seq: 3, delta: { seq: 3, view: { live: {} } } });
        await chat.see("and one is late");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows, ["two are blocked and one is late", ">"]);
    });

    it("prints an answer whose entry landed before the older partial of it arrived only once", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        await new Promise((resolve) => setTimeout(resolve, 20));

        chat.entries.push(answerEntry("e1", "all done here", 9));
        chat.feed({ seq: 1, delta: { seq: 1, view: { live: liveWith([{ type: "text", text: "all do" }], 9) } } });
        await chat.see("all done here");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows, ["all done here", ">"]);
    });

    it("starts a new line for a partial that does not continue the text already printed", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: liveWith([{ type: "text", text: "first try" }], 3) } });
        await chat.see("first try");

        chat.feed({ seq: 1, delta: { seq: 1, view: { live: liveWith([{ type: "text", text: "second try" }], 4) } } });
        await chat.see("second try");
        chat.entries.push(answerEntry("e1", "second try, finished", 4));
        chat.feed({ seq: 2, delta: { seq: 2, view: { live: {} } } });
        await chat.see("finished");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows, ["first try", "second try, finished", ">"]);
    });

    it("prints only the text a team member would read of a partial that holds thinking and a tool call", async () => {
        const chat = chatOnScriptedFeed();
        const content = [
            { type: "thinking", thinking: "secret reasoning" },
            { type: "text", text: "checking the jobs" },
            { type: "toolCall", id: "t1", name: "list_jobs", arguments: { status: "blocked" } },
        ];
        chat.feed({ snapshot: { entries: [], live: liveWith(content, 5) } });
        await chat.see("checking the jobs");
        await chat.leave();

        assert.equal(chat.screen().includes("secret reasoning"), false, chat.screen());
        assert.equal(chat.screen().includes("list_jobs"), false, chat.screen());
    });
});

const partialOf = (text: string, seq: number) => ({
    seq,
    delta: { seq, view: { live: liveWith([{ type: "text", text }], 7) } },
});

describe("runTerminalChat with the team member typing while an answer streams", () => {
    it("keeps_the_streamed_text_whole_when_a_typed_character_is_erased", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two jobs are running", 1));
        await chat.seeRow("two jobs are running");

        chat.type("abc\x7f");
        await chat.seeRow("> ab");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows.slice(-2), ["two jobs are running", "> ab"]);
    });

    it("keeps_a_line_being_typed_apart_from_the_answer_as_the_answer_grows", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two jobs", 1));
        await chat.seeRow("two jobs");

        chat.type("second line");
        await chat.seeRow("> second line");
        chat.feed(partialOf("two jobs are running\nand one is", 2));
        await chat.seeRow("and one is");
        chat.feed(partialOf("two jobs are running\nand one is blocked", 3));
        await chat.seeRow("and one is blocked");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows.slice(-3), ["two jobs are running", "and one is blocked", "> second line"]);
    });

    it("shows_a_submitted_line_once_and_the_answer_whole_below_it_when_enter_comes_during_the_answer", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two jobs are", 1));
        await chat.seeRow("two jobs are");

        chat.type("next question\r");
        await chat.seeRow("> next question");
        chat.feed(partialOf("two jobs are running", 2));
        chat.entries.push(answerEntry("e1", "two jobs are running", 7));
        chat.feed({ seq: 3, delta: { seq: 3, view: { live: {} } } });
        await chat.seeRow("two jobs are running");
        const rows = chat.rendered();
        await chat.leave();

        assert.equal(rows.filter((row) => row.includes("two jobs")).length, 1, rows.join("\n"));
        assert.equal(rows.filter((row) => row.includes("next question")).length, 1, rows.join("\n"));
        assert.deepEqual(rows.slice(-3), ["> next question", "two jobs are running", ">"]);
    });

    it("keeps_a_typed_line_that_wraps_below_an_answer_that_wraps", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.type("a line typed that runs over the width of the screen");
        await chat.seeRow("of the screen");
        chat.feed(partialOf("one two three four five six seven eight nine ten", 1));
        await chat.seeRow("nine ten");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows.slice(-4), [
            "one two three four five six seven eight",
            "nine ten",
            "> a line typed that runs over the width",
            "of the screen",
        ]);
    });
});
