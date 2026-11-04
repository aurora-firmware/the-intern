import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createClient } from "../../src/client/client.ts";
import { nodeTransport } from "../../src/client/node_transport.ts";
import { localSocketPath } from "../../src/daemon/state_layout.ts";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { hasScript, type PtySession, runInPty } from "../support/pty.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const FIRST = "what's running?";
const SECOND = "and what is blocked?";
const THIRD = "anything else?";
const LONG = "tell me everything about the running jobs please";
const WAIT_MS = 20_000;
const POLL_MS = 10;
const PROMPT = "> ";
const SKIP_REASON = "util-linux `script` is missing";

type Fixture = { env: HermeticEnv; daemon: DaemonProcess };
type Entry = { kind: string; data: unknown };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const sessions: PtySession[] = [];

afterEach(async () => {
    for (const session of sessions.splice(0)) {
        session.kill();
        await session.exited;
    }
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(script: FakeScript): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

function chat(fixture: Fixture, args: string[] = []): PtySession {
    const session = runInPty(["chat", ...args], { runtimeDir: fixture.env.runtimeDir });
    sessions.push(session);
    return session;
}

async function deskId(daemon: DaemonProcess): Promise<string> {
    return ((await daemon.invoke("desk.get", {})) as { conversationId: string }).conversationId;
}

async function entriesOf(daemon: DaemonProcess): Promise<Entry[]> {
    const conversationId = await deskId(daemon);
    return ((await daemon.invoke("conversations.entries", { conversationId })) as { entries: Entry[] }).entries;
}

/** Answers once the lines are written to the front desk with the piped chat, which waits for each answer. */
async function earlierMessages(fixture: Fixture, text: string): Promise<void> {
    const result = await runBob(["chat"], {
        runtimeDir: fixture.env.runtimeDir,
        env: fixture.env.env,
        stdin: `${text}\n`,
    });
    assert.equal(result.status, 0, result.stderr);
}

/** The text of the front desk's inbox, read from the first snapshot of its conversation feed. */
async function inboxOf(fixture: Fixture): Promise<string> {
    const client = createClient(nodeTransport({ socketPath: localSocketPath(fixture.env.runtimeDir) }));
    const subscription = client.subscribe({ scope: "conversation", conversationId: await deskId(fixture.daemon) });
    try {
        const first = await subscription.next();
        const snapshot = first.done ? {} : ((first.value as { snapshot?: { inbox?: unknown } }).snapshot ?? {});
        return JSON.stringify(snapshot.inbox ?? null);
    } finally {
        subscription.return({ end: "unsubscribed" }).catch(() => {});
    }
}

async function until(isDone: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await isDone())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** The exit status of the session, or a failure when it hasn't ended by the deadline. */
async function exitStatus(session: PtySession): Promise<number | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bob chat did not exit; output ${session.output()}`)), WAIT_MS);
    });
    try {
        return await Promise.race([session.exited, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

const skip = !hasScript() && !process.env.CI ? SKIP_REASON : false;

describe("bob chat on a terminal", { skip }, () => {
    it("shows the last messages and a prompt", async () => {
        const fixture = await readyDaemon("echo");
        await earlierMessages(fixture, "earlier question");
        const session = chat(fixture);

        await session.waitFor("output", PROMPT);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        assert.ok(session.output().includes("input: earlier question"), session.output());
        assert.ok(session.output().includes("assistant: echo: earlier question"), session.output());
    });

    it("shows history that holds control sequences without them, as plain lines", async () => {
        const fixture = await readyDaemon("echo");
        const hostile = `earlier${ESC}]52;c;ZXZpbA==${BEL}${ESC}[2K question`;
        await earlierMessages(fixture, hostile);
        const sent = await runBob(
            ["conversations", "send", await deskId(fixture.daemon), `sent\nassistant: forged ${hostile}`],
            { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env },
        );
        assert.equal(sent.status, 0, sent.stderr);
        const session = chat(fixture);

        await session.waitFor("output", PROMPT);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        const output = session.output();
        assert.ok(output.includes("input: earlier question"), output);
        assert.ok(output.includes("input: sent assistant: forged earlier question"), output);
        assert.ok(!/(^|\n)assistant: forged/.test(output), output);
        assert.ok(output.includes("assistant: echo: earlier question"), output);
        assert.ok(!output.includes("52;c;"), output);
        assert.ok(!output.includes(BEL), output);
    });

    it("queues a second line behind the streaming answer, answers it next and records both with the command line way in", async () => {
        const fixture = await readyDaemon("gated");
        const session = chat(fixture);
        await session.waitFor("output", PROMPT);

        session.write(`${FIRST}\r`);
        await until(async () => JSON.stringify(await entriesOf(fixture.daemon)).includes(FIRST), "the first line");
        session.write(`${SECOND}\r`);
        await until(async () => (await inboxOf(fixture)).includes(SECOND), "the second line queued");
        assert.equal(session.output().includes("echo: "), false, "no answer while the run is held");
        fixture.daemon.releaseRuns();
        await session.waitFor("output", `echo: ${SECOND}`);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        const printed = session.output();
        assert.ok(printed.indexOf(`echo: ${FIRST}`) !== -1);
        assert.ok(printed.indexOf(`echo: ${FIRST}`) < printed.indexOf(`echo: ${SECOND}`));
        const transcript = JSON.stringify(await entriesOf(fixture.daemon));
        assert.ok(transcript.includes('"wayIn":"command line"'), transcript);
    });

    it("stops the turn on Ctrl-C, names the queued line as dropped, and answers a later line before Ctrl-D exits 0", async () => {
        const fixture = await readyDaemon("gated");
        const session = chat(fixture);
        await session.waitFor("output", PROMPT);

        session.write(`${FIRST}\r`);
        session.write(`${SECOND}\r`);
        session.write(CTRL_C);
        await session.waitFor("stderr", SECOND);
        assert.equal(session.output().includes(`echo: ${SECOND}`), false);

        fixture.daemon.releaseRuns();
        session.write(`${THIRD}\r`);
        await session.waitFor("output", `echo: ${THIRD}`);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        assert.ok(session.stderr().includes(`Dropped, not answered: ${SECOND}`), session.stderr());
        assert.ok(session.stderr().includes(`Dropped, not answered: ${FIRST}`), session.stderr());
        assert.equal(session.output().includes(`echo: ${SECOND}`), false);
    });

    it("keeps the front desk's conversation and its entries and empties the next context with --reset", async () => {
        const fixture = await readyDaemon("echo");
        await earlierMessages(fixture, "before the reset");
        const idBefore = await deskId(fixture.daemon);
        const session = chat(fixture, ["--reset"]);

        await session.waitFor("output", PROMPT);
        session.write(`${FIRST}\r`);
        await session.waitFor("output", `echo: ${FIRST}`);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        assert.equal(await deskId(fixture.daemon), idBefore);
        const kinds = (await entriesOf(fixture.daemon)).map((entry) => entry.kind);
        assert.ok(kinds.includes("pi.reset"));
        const context = (await fixture.daemon.invoke("conversations.context", { conversationId: idBefore })) as Entry[];
        assert.equal(JSON.stringify(context).includes("before the reset"), false);
        assert.ok(JSON.stringify(context).includes(FIRST));
    });

    it("prints the desk answer, the history answers and the feed snapshot and deltas as JSON lines with --json", async () => {
        const fixture = await readyDaemon("echo");
        await earlierMessages(fixture, "earlier question");
        const session = chat(fixture, ["--json"]);

        await session.waitFor("stderr", PROMPT);
        session.write(`${FIRST}\r`);
        await session.waitFor("output", `echo: ${FIRST}`);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        const values = session
            .output()
            .split(/\r?\n/)
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(values[0]?.conversationId, await deskId(fixture.daemon));
        assert.ok(Array.isArray(values[1]?.entries), "the history answer follows the desk answer");
        assert.ok(
            values.some((value) => "live" in value && Array.isArray(value.entries)),
            "a feed snapshot",
        );
        assert.ok(
            values.some((value) => "seq" in value && "ops" in value),
            "a feed delta",
        );
        assert.ok(JSON.stringify(values).includes(`echo: ${FIRST}`));
    });
});

function occurrences(text: string, part: string): number {
    return text.split(part).length - 1;
}

async function assistantEntryCount(daemon: DaemonProcess): Promise<number> {
    return (await entriesOf(daemon)).filter((entry) => entry.kind === "pi.assistant").length;
}

describe("bob chat streaming an answer", { skip }, () => {
    it("prints the first part of the answer before the turn ends and the rest after, each once", async () => {
        const fixture = await readyDaemon("streaming-gated");
        const session = chat(fixture);
        await session.waitFor("output", PROMPT);

        session.write(`${LONG}\r`);
        await session.waitFor("output", "echo: tell");
        assert.equal(await assistantEntryCount(fixture.daemon), 0, "the turn is still running");
        assert.equal(session.output().includes(`echo: ${LONG}`), false, "only the first part is on screen");
        fixture.daemon.releaseRuns();
        await session.waitFor("output", `echo: ${LONG}`);
        session.write(CTRL_D);

        assert.equal(await exitStatus(session), 0, session.stderr());
        assert.equal(occurrences(session.output(), "echo: tell"), 1, session.output());
        assert.equal(occurrences(session.output(), `echo: ${LONG}`), 1, session.output());
    });

    it("keeps the part already printed once, and ends its line, when Ctrl-C cuts the answer off", async () => {
        const fixture = await readyDaemon("streaming-gated");
        const session = chat(fixture);
        await session.waitFor("output", PROMPT);
        session.write(`${LONG}\r`);
        await session.waitFor("output", "echo: tell");

        session.write(CTRL_C);
        await until(async () => (await assistantEntryCount(fixture.daemon)) === 1, "the aborted answer entry");
        fixture.daemon.releaseRuns();
        session.write(`${THIRD}\r`);
        await session.waitFor("output", `echo: ${THIRD}`);
        session.write(CTRL_D);

        assert.equal(await exitStatus(session), 0, session.stderr());
        assert.equal(occurrences(session.output(), "echo: tell"), 1, session.output());
        assert.equal(session.output().includes(`echo: ${LONG}`), false, "the cut-off answer was not completed");
    });
});

describe("bob chat leaving while a turn is running", { skip }, () => {
    it("prints the answer and exits 0 when Ctrl-D comes before the answer", async () => {
        const fixture = await readyDaemon("gated");
        const session = chat(fixture);
        await session.waitFor("output", PROMPT);
        session.write(`${FIRST}\r`);
        await until(async () => JSON.stringify(await entriesOf(fixture.daemon)).includes(FIRST), "the first line");

        session.write(CTRL_D);
        fixture.daemon.releaseRuns();

        assert.equal(await exitStatus(session), 0, session.stderr());
        assert.ok(session.output().includes(`echo: ${FIRST}`), session.output());
        assert.equal(session.stderr(), "");
    });

    it("exits 0 and names the dropped line when Ctrl-C is followed at once by Ctrl-D", async () => {
        const fixture = await readyDaemon("gated");
        const session = chat(fixture);
        await session.waitFor("output", PROMPT);
        session.write(`${FIRST}\r`);
        await until(async () => JSON.stringify(await entriesOf(fixture.daemon)).includes(FIRST), "the first line");

        session.write(`${CTRL_C}${CTRL_D}`);

        assert.equal(await exitStatus(session), 0, session.stderr());
        assert.equal(session.stderr(), `Dropped, not answered: ${FIRST}\n`);
    });
});

describe("bob chat with standard output redirected", { skip }, () => {
    it("reads lines from the terminal with no prompt and writes only the answer to the file", async () => {
        const fixture = await readyDaemon("echo");
        await earlierMessages(fixture, "earlier question");
        const session = runInPty(["chat"], { runtimeDir: fixture.env.runtimeDir, redirectStdout: true });
        sessions.push(session);

        session.write(`${FIRST}\r`);
        await session.waitFor("stdout", `echo: ${FIRST}`);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        assert.equal(session.stdout(), `echo: ${FIRST}\n`);
    });
});

describe("bob chat --reset without a terminal", () => {
    it("empties the front desk's next context and keeps its conversation", async () => {
        const fixture = await readyDaemon("echo");
        await earlierMessages(fixture, "before the reset");
        const idBefore = await deskId(fixture.daemon);

        const result = await runBob(["chat", "--reset"], {
            runtimeDir: fixture.env.runtimeDir,
            env: fixture.env.env,
            stdin: `${FIRST}\n`,
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `echo: ${FIRST}\n`);
        assert.equal(await deskId(fixture.daemon), idBefore);
        const context = JSON.stringify(
            await fixture.daemon.invoke("conversations.context", { conversationId: idBefore }),
        );
        assert.equal(context.includes("before the reset"), false);
        assert.ok(context.includes(FIRST));
    });
});
