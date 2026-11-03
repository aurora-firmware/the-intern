import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runPipedChat } from "../../src/cli/chat_command.ts";
import type { CommandIo } from "../../src/cli/command_line.ts";
import type { Client } from "../../src/client/client.ts";

const DESK_ID = "desk-1";
type Entry = { id: string; kind: string; data: unknown };
type Call = { name: string; input: Record<string, unknown> };

const user = (text: string, id: string): Entry => ({ id, kind: "pi.user", data: [{ role: "user", content: text }] });
const assistant = (text: string, id: string): Entry => ({
    id,
    kind: "pi.assistant",
    data: [{ role: "assistant", content: [{ type: "text", text }] }],
});

/** A client whose waits answer from the script in order and whose entries grow when a line is submitted. */
function scriptedClient(options: { waits: string[]; answers: string[] }) {
    const calls: Call[] = [];
    const entries: Entry[] = [];
    const waits = [...options.waits];
    const answers = [...options.answers];
    let submitted = 0;
    const client: Client = {
        async invoke(name, input) {
            const record = (input ?? {}) as Record<string, unknown>;
            calls.push({ name, input: record });
            if (name === "desk.get") return { conversationId: DESK_ID };
            if (name === "conversations.submit") {
                submitted += 1;
                entries.push(user(String(record.content), `u${submitted}`));
                entries.push(assistant(answers.shift() ?? "", `a${submitted}`));
                return { submissionId: `s${submitted}` };
            }
            if (name === "submissions.wait") return { state: waits.shift() };
            if (name === "conversations.entries") return { entries: [...entries] };
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
});
