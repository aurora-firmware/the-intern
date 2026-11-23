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
const SCREEN_ROWS = 10;

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
        subscribeConversations: () => {
            throw new Error("this test never subscribes to several conversations");
        },
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
function chatOnScriptedFeed(reportedColumns = SCREEN_COLUMNS) {
    const entries: Entry[] = [];
    const queue: unknown[] = [];
    let wake = () => {};
    const client: Client = {
        subscribeConversations: () => {
            throw new Error("this test never subscribes to several conversations");
        },
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
    Object.assign(io.stdout, { columns: reportedColumns, rows: SCREEN_ROWS });
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
        rendered: () => renderTerminal(screen, { columns: SCREEN_COLUMNS, height: SCREEN_ROWS }).rows,
        /** The screen, with its scrollback, cursor and visible rows. */
        terminal: () => renderTerminal(screen, { columns: SCREEN_COLUMNS, height: SCREEN_ROWS }),
        type(keys: string) {
            (io.stdin as PassThrough).write(keys);
        },
        async seeRow(text: string) {
            const deadline = Date.now() + 5000;
            while (!renderTerminal(screen, { columns: SCREEN_COLUMNS, height: SCREEN_ROWS }).rows.includes(text)) {
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
        chat.feed(partialOf("one two thrhree four five six seven eight nine ten", 1));
        await chat.seeRow("hree four five six seven eight nine ten");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows.slice(-3), [
            "hree four five six seven eight nine ten",
            "> a line typed that runs over the width",
            "of the screen",
        ]);
    });
});

/** Words `w001 w002 ...`: a paragraph with no line break, each word one marker to count. */
const paragraphOf = (words: number) => Array.from({ length: words }, (_, n) => `w${String(n + 1).padStart(3, "0")}`);

describe("runTerminalChat with an unfinished answer line taller than the screen", () => {
    it("keeps_one_copy_of_the_paragraph_in_the_scrollback_while_it_streams_and_when_its_entry_lands", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        const words = paragraphOf(120);
        for (let count = 5; count <= words.length; count += 5) {
            chat.feed(partialOf(words.slice(0, count).join(" "), count));
            await chat.see(words[count - 1] as string);
        }
        const whileStreaming = chat.terminal();
        chat.entries.push(answerEntry("e1", words.join(" "), 7));
        chat.feed({ seq: 99, delta: { seq: 99, view: { live: {} } } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const done = chat.terminal();
        await chat.leave();

        for (const word of words) {
            assert.equal(done.rows.join(" ").split(word).length - 1, 1, `${word} once in ${done.rows.join("\n")}`);
        }
        assert.deepEqual(done.lines, [words.join(" "), ">"]);
        assert.ok(done.scrollback.length > 0, "the paragraph is taller than the screen");
        assert.deepEqual(whileStreaming.scrollback, []);
        assert.equal(whileStreaming.lines.length, 2, whileStreaming.lines.join("\n"));
        assert.ok(whileStreaming.lines[0]?.endsWith(words.at(-1) as string), whileStreaming.lines.join("\n"));
    });

    it("leaves_nothing_in_the_scrollback_of_a_terminal_that_keeps_the_rows_a_clear_from_home_erases", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        const words = paragraphOf(40);
        for (let count = 5; count <= words.length; count += 5) {
            chat.feed(partialOf(words.slice(0, count).join(" "), count));
            await chat.see(words[count - 1] as string);
        }
        const kept = renderTerminal(chat.screen(), {
            columns: SCREEN_COLUMNS,
            height: SCREEN_ROWS,
            isHomeClearKept: true,
        });
        await chat.leave();

        assert.deepEqual(kept.scrollback, []);
        assert.equal(kept.lines.length, 2, kept.lines.join("\n"));
    });

    it("clears_a_wrapped_typed_line_from_under_the_answer_with_the_cursor_on_its_first_row", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        const typed = "a line that takes two rows of the forty column screen as it does and goes on past them";
        for (const key of typed) {
            chat.type(key);
            await new Promise((resolve) => setImmediate(resolve));
        }
        await chat.see("goes on");
        chat.type("\u0001");
        await new Promise((resolve) => setTimeout(resolve, 20));
        chat.feed(partialOf("streamed one\nstreamed two\nstreamed three\n", 1));
        await chat.see("streamed three");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { lines } = chat.terminal();
        chat.type("\u0005\u0015");
        await chat.leave();

        assert.deepEqual(lines, ["streamed one", "streamed two", "streamed three", `> ${typed}`]);
    });
});

const URL_TEXT = "https://example.com/docs/a/long/path/to/some/page/that/does/not/fit?query=value&other=1";
const COMMAND_TEXT = "docker run --rm -it -v /srv/data:/data -p 8080:80 --name web example/web:latest --verbose";

/** The answer fed word by word as partials, and then its entry, so the line grows across many redraws. */
async function streamAnswer(chat: ReturnType<typeof chatOnScriptedFeed>, text: string) {
    const words = text.split(" ");
    for (let count = 1; count <= words.length; count++) {
        chat.feed(partialOf(words.slice(0, count).join(" "), count));
        await chat.see(words[count - 1]?.slice(-4) as string);
    }
    chat.entries.push(answerEntry("e1", text, 7));
    chat.feed({ seq: 999, delta: { seq: 999, view: { live: {} } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("runTerminalChat with an answer line wider than a row", () => {
    for (const [name, line] of [
        ["a_url", URL_TEXT],
        ["a_docker_run_command", COMMAND_TEXT],
    ] as const) {
        it(`keeps_${name}_in_one_line_that_the_terminal_wraps_when_the_answer_is_written`, async () => {
            const chat = chatOnScriptedFeed();
            chat.feed({ snapshot: { entries: [], live: {} } });
            await streamAnswer(chat, `Run this:\n${line}\nThen stop.`);
            const { lines } = chat.terminal();
            await chat.leave();

            assert.deepEqual(lines, ["Run this:", line, "Then stop.", ">"]);
        });

        it(`shows_only_one_transient_row_of_${name}_while_it_streams_and_writes_it_whole_at_its_end`, async () => {
            const chat = chatOnScriptedFeed();
            chat.feed({ snapshot: { entries: [], live: {} } });
            const half = line.slice(0, line.lastIndexOf(" "));
            chat.feed(partialOf(`first\n${half}`, 1));
            await chat.see(half.slice(-6));
            const whileStreaming = chat.terminal();
            chat.feed(partialOf(`first\n${line}\nnext`, 2));
            await chat.see(line.slice(-6));
            await new Promise((resolve) => setTimeout(resolve, 20));
            const afterTheLineEnded = chat.terminal();
            await chat.leave();

            assert.deepEqual(whileStreaming.lines, ["first", half.slice(-(SCREEN_COLUMNS - 1)), ">"]);
            assert.deepEqual(afterTheLineEnded.lines, ["first", line, "next", ">"]);
        });
    }

    it("writes_a_line_wider_than_a_row_whole_when_the_answer_ends_without_a_newline", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf(COMMAND_TEXT, 1));
        await chat.see(COMMAND_TEXT.slice(-6));
        chat.type(CTRL_D);
        chat.entries.push(answerEntry("e1", COMMAND_TEXT, 7));
        assert.equal(await chat.finished, 0);

        const { lines } = chat.terminal();
        assert.ok(lines.includes(COMMAND_TEXT), lines.join("\n"));
    });
});

const CTRL_D = "\x04";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";

describe("runTerminalChat with the line editor in use while a partial arrives", () => {
    it("keeps_the_arrows_browsing_the_history_when_a_partial_arrives_between_two_presses", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.type("one\r");
        await chat.seeRow("> one");
        chat.type("two\r");
        await chat.seeRow("> two");
        chat.type("three\r");
        await chat.seeRow("> three");
        chat.type(UP);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(chat.rendered().at(-1), "> three");

        chat.feed(partialOf("an answer", 1));
        await chat.seeRow("an answer");
        chat.type(UP);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(chat.rendered().at(-1), "> two");
        chat.type(DOWN);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const rows = chat.rendered();
        await chat.leave();

        assert.equal(rows.at(-1), "> three", rows.join("\n"));
        assert.equal(rows.filter((row) => row === "an answer").length, 1, rows.join("\n"));
    });

    it("leaves_the_cursor_where_the_team_member_put_it_when_a_partial_arrives", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.type(`a\u{1F600}b${LEFT}${LEFT}`);
        await chat.seeRow("> a\u{1F600}b");

        chat.feed(partialOf("an answer", 1));
        await chat.seeRow("an answer");
        const { cursor, screen } = chat.terminal();
        chat.type("X");
        await chat.seeRow("> aX\u{1F600}b");
        await chat.leave();

        assert.equal(screen[cursor.row], "> a\u{1F600}b");
        assert.equal(cursor.column, "> a".length);
    });

    it("keeps_the_unfinished_line_once_above_a_blank_prompt_when_enter_comes_on_an_empty_line", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two jobs are", 1));
        await chat.seeRow("two jobs are");

        chat.type("\r");
        await new Promise((resolve) => setTimeout(resolve, 50));
        chat.feed(partialOf("two jobs are running", 2));
        await chat.seeRow("two jobs are running");
        const rows = chat.rendered();
        await chat.leave();

        assert.equal(rows.filter((row) => row.includes("two jobs")).length, 1, rows.join("\n"));
        assert.deepEqual(rows.slice(-3), [">", "two jobs are running", ">"]);
    });

    it("removes_a_control_sequence_cut_between_two_partials_from_the_screen", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two \u001b[3", 1));
        await chat.seeRow("two");
        chat.feed(partialOf("two \u001b[31mjobs\u001b[0m run\u001b]0;title\u0007 on", 2));
        await chat.seeRow("two jobs run on");
        const written = chat.screen();
        await chat.leave();

        for (const sequence of ["\u001b[31m", "\u001b[0m", "\u001b]0;", "\u0007"]) {
            assert.equal(written.includes(sequence), false, JSON.stringify(sequence));
        }
    });

    it("keeps_a_paragraph_of_wide_characters_in_one_copy_with_the_transient_row_inside_the_screen_width", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        const text = Array.from({ length: 150 }, (_, n) => String.fromCodePoint(0x3042 + (n % 40))).join("");
        for (let length = 10; length <= text.length; length += 10) {
            chat.feed(partialOf(text.slice(0, length), length));
            await chat.see(text.slice(length - 1, length));
        }
        const whileStreaming = chat.terminal();
        chat.entries.push(answerEntry("e1", text, 7));
        chat.feed({ seq: 99, delta: { seq: 99, view: { live: {} } } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const done = chat.terminal();
        await chat.leave();

        assert.deepEqual(done.lines, [text, ">"]);
        assert.equal(whileStreaming.rows.length, 2, whileStreaming.rows.join("\n"));
        assert.ok((whileStreaming.rows[0] as string).length * 2 < SCREEN_COLUMNS, whileStreaming.rows[0]);
    });

    it("shows_the_unfinished_line_once_and_only_when_it_completes_when_the_input_closes_during_a_stream", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two jobs are", 1));
        await chat.seeRow("two jobs are");

        chat.entries.push(answerEntry("e1", "two jobs are running", 7));
        chat.type(CTRL_D);
        assert.equal(await chat.finished, 0);
        const rows = chat.rendered();

        assert.equal(rows.filter((row) => row.includes("two jobs")).length, 1, rows.join("\n"));
        assert.ok(
            rows.some((row) => row.endsWith("two jobs are running")),
            rows.join("\n"),
        );
    });
});

describe("runTerminalChat when Ctrl-C comes with a line half typed", () => {
    it("leaves_the_typed_text_and_its_cursor_as_they_were", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.type("half of a thou");
        await chat.seeRow("> half of a thou");

        chat.type("\x03");
        await new Promise((resolve) => setTimeout(resolve, 50));
        chat.type("ght");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { lines } = chat.terminal();
        await chat.leave();

        assert.deepEqual(lines.slice(-1), ["> half of a thought"]);
    });

    it("leaves_the_cursor_in_the_middle_of_the_line_where_it_was", async () => {
        const chat = chatOnScriptedFeed();
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.type(`half${LEFT}${LEFT}`);
        await chat.seeRow("> half");

        chat.type("\x03");
        await new Promise((resolve) => setTimeout(resolve, 50));
        chat.type("X");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { lines } = chat.terminal();
        await chat.leave();

        assert.deepEqual(lines.slice(-1), ["> haXlf"]);
    });
});

describe("runTerminalChat on a terminal that reports no width", () => {
    it("prints_an_answer_that_fits_a_usual_row_on_one_row", async () => {
        const chat = chatOnScriptedFeed(0);
        chat.feed({ snapshot: { entries: [], live: {} } });
        chat.feed(partialOf("two jobs are running and one is blocked", 1));
        await chat.seeRow("two jobs are running and one is blocked");
        const rows = chat.rendered();
        await chat.leave();

        assert.deepEqual(rows.slice(-2), ["two jobs are running and one is blocked", ">"]);
    });
});
