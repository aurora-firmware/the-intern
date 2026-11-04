import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runPipedChat } from "../../src/cli/chat_command.ts";
import type { CommandIo } from "../../src/cli/command_line.ts";
import { type Client, UnreachableError } from "../../src/client/client.ts";

const DESK_ID = "desk-1";
type Entry = { id: string; kind: string; data: unknown };
type Call = { name: string; input: Record<string, unknown> };

const user = (text: string, id: string): Entry => ({ id, kind: "pi.user", data: [{ role: "user", content: text }] });
const assistant = (text: string, id: string): Entry => ({
    id,
    kind: "pi.assistant",
    data: [{ role: "assistant", content: [{ type: "text", text }] }],
});

// Pages the way the service does: `after` is an opaque cursor and `next` is present while more entries follow.
function entriesPage(entries: Entry[], after: unknown, pageSize = entries.length) {
    const start = typeof after === "string" ? Number(after) : 0;
    const end = start + Math.max(pageSize, 1);
    return { entries: entries.slice(start, end), ...(end < entries.length && { next: String(end) }) };
}

/** A client whose waits answer from the script in order and whose entries grow when a line is submitted. */
function scriptedClient(options: { waits: string[]; answers: string[]; pageSize?: number; held?: boolean }) {
    const calls: Call[] = [];
    const entries: Entry[] = [];
    const preexisting = options.pageSize === undefined ? [] : [assistant("old 1", "o1"), assistant("old 2", "o2")];
    entries.push(...preexisting);
    const waits = [...options.waits];
    const answers = [...options.answers];
    let submitted = 0;
    const client: Client = {
        async invoke(name, input) {
            const record = (input ?? {}) as Record<string, unknown>;
            calls.push({ name, input: record });
            if (name === "desk.get") return { conversationId: DESK_ID };
            if (name === "conversations.submit") {
                if (options.held === true) return { held: true };
                submitted += 1;
                entries.push(user(String(record.content), `u${submitted}`));
                entries.push(assistant(answers.shift() ?? "", `a${submitted}`));
                return { submissionId: `s${submitted}` };
            }
            if (name === "submissions.wait") return { state: waits.shift() };
            if (name === "conversations.entries") return entriesPage(entries, record.after, options.pageSize);
            throw new Error(`unexpected ${name}`);
        },
        subscribe() {
            throw new Error("not used");
        },
    };
    return { client, calls };
}

function pipedIo(lines: string[]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let text = "";
    stdout.on("data", (chunk) => {
        text += chunk;
    });
    stdin.end(lines.map((line) => `${line}\n`).join(""));
    const io: CommandIo = {
        stdout,
        stderr: new PassThrough(),
        stdin,
        env: {},
        cwd: "/work",
        homeDir: "/home",
        isStdoutTerminal: false,
        isStdinTerminal: false,
    };
    return { io, stdout: () => text };
}

describe("runPipedChat", () => {
    it("waits a second time when the first wait ends unsettled and prints the answer once", async () => {
        const { client, calls } = scriptedClient({ waits: ["running", "done"], answers: ["two are blocked"] });
        const piped = pipedIo(["what's blocked?"]);
        const status = await runPipedChat(client, piped.io, false);
        assert.equal(status, 0);
        assert.equal(calls.filter((call) => call.name === "submissions.wait").length, 2);
        assert.equal(piped.stdout(), "two are blocked\n");
    });

    it("submits each line as a follow-up only after the previous one settled and prints answers in order", async () => {
        const { client, calls } = scriptedClient({
            waits: ["done", "done"],
            answers: ["first answer", "second answer"],
        });
        const piped = pipedIo(["one", "two"]);
        await runPipedChat(client, piped.io, false);
        const order = calls.map((call) => call.name).filter((name) => name !== "conversations.entries");
        assert.deepEqual(order, [
            "desk.get",
            "conversations.submit",
            "submissions.wait",
            "conversations.submit",
            "submissions.wait",
        ]);
        const submits = calls.filter((call) => call.name === "conversations.submit");
        assert.deepEqual(
            submits.map((call) => [call.input.conversationId, call.input.content, call.input.busyMode]),
            [
                [DESK_ID, "one", "followUp"],
                [DESK_ID, "two", "followUp"],
            ],
        );
        assert.equal(piped.stdout(), "first answer\nsecond answer\n");
    });

    it("prints the entries answer unchanged as one JSON line in json mode", async () => {
        const { client } = scriptedClient({ waits: ["done"], answers: ["hello"] });
        const piped = pipedIo(["hi"]);
        await runPipedChat(client, piped.io, true);
        const lines = piped.stdout().trimEnd().split("\n");
        assert.equal(lines.length, 1);
        const answer = JSON.parse(lines[0] as string) as { entries: Entry[] };
        assert.deepEqual(answer.entries, [user("hi", "u1"), assistant("hello", "a1")]);
    });

    it("prints only the answer to the submitted line when the earlier entries span several pages", async () => {
        const { client } = scriptedClient({ waits: ["done"], answers: ["new answer"], pageSize: 1 });
        const piped = pipedIo(["hi"]);
        await runPipedChat(client, piped.io, false);
        assert.equal(piped.stdout(), "new answer\n");
    });

    it("prints every page it read for the line in json mode when the entries span several pages", async () => {
        const { client } = scriptedClient({ waits: ["done"], answers: ["new answer"], pageSize: 1 });
        const piped = pipedIo(["hi"]);
        await runPipedChat(client, piped.io, true);
        const pages = piped
            .stdout()
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as { entries: Entry[] });
        assert.deepEqual(
            pages.flatMap((page) => page.entries.map((entry) => entry.id)),
            ["o2", "u1", "a1"],
        );
    });

    it("prints the answer when the submission ends unanswered", async () => {
        const { client } = scriptedClient({ waits: ["unanswered"], answers: ["partial"] });
        const piped = pipedIo(["hi"]);
        const status = await runPipedChat(client, piped.io, false);
        assert.equal(status, 0);
        assert.equal(piped.stdout(), "partial\n");
    });

    it("exits 1 with a notice on stderr and submits no further line when the front desk holds a line", async () => {
        const { client, calls } = scriptedClient({ waits: [], answers: [], held: true });
        const piped = pipedIo(["one", "two"]);
        let notice = "";
        piped.io.stderr.on("data", (chunk) => {
            notice += chunk;
        });
        const status = await runPipedChat(client, piped.io, false);
        assert.equal(status, 1);
        assert.equal(piped.stdout(), "");
        assert.ok(notice.includes("one"), notice);
        assert.equal(calls.filter((call) => call.name === "conversations.submit").length, 1);
    });

    it("keeps trying a line with its one request id and prints one notice when the daemon is gone for two attempts", async () => {
        const scripted = scriptedClient({ waits: ["done"], answers: ["still here"] });
        let refusals = 2;
        const requestIds: unknown[] = [];
        const client: Client = {
            subscribe: scripted.client.subscribe,
            invoke(name, input) {
                if (name === "conversations.submit") requestIds.push((input as { requestId?: unknown }).requestId);
                if (name === "conversations.submit" && refusals-- > 0) {
                    return Promise.reject(new UnreachableError("/run/bob.sock", "gone"));
                }
                return scripted.client.invoke(name, input);
            },
        };
        const piped = pipedIo(["are you there?"]);
        let notices = "";
        piped.io.stderr.on("data", (chunk) => {
            notices += chunk;
        });

        const status = await runPipedChat(client, piped.io, false);

        assert.equal(status, 0);
        assert.equal(piped.stdout(), "still here\n");
        assert.equal(notices, "The Intern isn't reachable; trying again\n");
        assert.equal(requestIds.length, 3, "two refused attempts and the one that got through");
        assert.equal(new Set(requestIds).size, 1, `one request id for every attempt: ${requestIds}`);
        assert.equal(typeof requestIds[0], "string");
    });
});
