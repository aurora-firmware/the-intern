import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { hasScript, type PtySession, runInPty } from "../support/pty.ts";

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const FIRST = "what's running?";
const SECOND = "and what is blocked?";
const THIRD = "anything else?";
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

const skip = !hasScript() && !process.env.CI ? SKIP_REASON : false;

describe("bob chat on a terminal", { skip }, () => {
    it("shows the last messages and a prompt, then answers both typed lines with the command line way in", async () => {
        const fixture = await readyDaemon("echo");
        await earlierMessages(fixture, "earlier question");
        const session = chat(fixture);

        await session.waitFor("output", PROMPT);
        assert.ok(session.output().includes("user: earlier question"), session.output());
        assert.ok(session.output().includes("assistant: echo: earlier question"), session.output());
        session.write(`${FIRST}\r${SECOND}\r`);
        await session.waitFor("output", `echo: ${FIRST}`);
        await session.waitFor("output", `echo: ${SECOND}`);
        session.write(CTRL_D);

        assert.equal(await session.exited, 0, session.stderr());
        const transcript = JSON.stringify(await entriesOf(fixture.daemon));
        assert.ok(transcript.includes(FIRST) && transcript.includes(SECOND));
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
        console.log("ERR", JSON.stringify(session.stderr()));
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
