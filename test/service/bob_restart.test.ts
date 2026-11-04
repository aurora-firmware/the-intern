import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type BobChild, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { hasScript, type PtySession, runInPty } from "../support/pty.ts";
import { renderTerminal } from "../support/screen_renderer.ts";

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const LINE = "are you still there?";
const LONG_LINE = "tell me everything about the running jobs please";
const PROMPT = "> ";
const UNREACHABLE_NOTICE = "The Intern isn't reachable; trying again";
const WAIT_MS = 20_000;
const POLL_MS = 10;
const SKIP_REASON = "util-linux `script` is missing";

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const children: BobChild[] = [];
const sessions: PtySession[] = [];

afterEach(async () => {
    for (const session of sessions.splice(0)) {
        session.kill();
        await session.exited;
    }
    for (const child of children.splice(0)) {
        child.signal("SIGKILL");
        await child.exited;
    }
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(env: HermeticEnv, script: FakeScript = "gated"): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

async function until(isDone: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await isDone())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function entriesText(daemon: DaemonProcess): Promise<string> {
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    return JSON.stringify(await daemon.invoke("conversations.entries", { conversationId }));
}

// The text output has no marker of a subscription, so probe jobs are created until one shows as a line.
async function waitUntilFollowing(daemon: DaemonProcess, follow: BobChild): Promise<void> {
    const before = occurrences(follow.stdout(), " created ");
    await until(async () => {
        await daemon.invoke("jobs.create", { text: "probe" });
        await new Promise((resolve) => setTimeout(resolve, 200));
        return occurrences(follow.stdout(), " created ") > before;
    }, "the follow to print a probe job");
}

function occurrences(text: string, part: string): number {
    return text.split(part).length - 1;
}

type Scenario = { env: HermeticEnv; chat: PtySession; follow: BobChild; restarted: DaemonProcess };

/** Runs a chat with a line waiting and a follow, kills the daemon, and starts it again on the same directories. */
async function restartWhileWaiting(): Promise<Scenario> {
    const env = await createHermeticEnv();
    envs.push(env);
    const first = await readyDaemon(env);
    const chat = runInPty(["chat"], { runtimeDir: env.runtimeDir });
    sessions.push(chat);
    const follow = spawnBob(["follow"], { runtimeDir: env.runtimeDir, env: env.env });
    children.push(follow);
    await chat.waitFor("output", PROMPT);

    chat.write(`${LINE}\r`);
    await until(async () => (await entriesText(first)).includes(LINE), "the line to reach the front desk");
    await waitUntilFollowing(first, follow);

    first.kill9();
    await first.exited;
    await chat.waitFor("stderr", UNREACHABLE_NOTICE);
    await follow.waitFor("stderr", UNREACHABLE_NOTICE);
    const restarted = await readyDaemon(env);
    return { env, chat, follow, restarted };
}

/** The team member's inputs to the front desk, in the order they were admitted. */
async function inputsOf(daemon: DaemonProcess): Promise<string[]> {
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId })) as {
        entries: { kind: string; data: { content?: string } }[];
    };
    return entries.flatMap((entry) => (entry.kind === "intern.steer" ? [String(entry.data.content)] : []));
}

async function assistantEntryCount(daemon: DaemonProcess): Promise<number> {
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId })) as {
        entries: { kind: string }[];
    };
    return entries.filter((entry) => entry.kind === "pi.assistant").length;
}

async function exitedWithin(child: BobChild, what: string): Promise<number | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not exit; stderr ${child.stderr()}`)), WAIT_MS);
    });
    try {
        return await Promise.race([child.exited, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

describe("piped bob chat across a daemon restart", () => {
    it("prints a notice, waits for the daemon and prints the answer once, with the line admitted once", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const first = await readyDaemon(env);
        const chat = spawnBob(["chat"], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(chat);
        chat.write(`${LINE}\n`);
        await until(async () => (await entriesText(first)).includes(LINE), "the line to reach the front desk");

        first.kill9();
        await first.exited;
        await chat.waitFor("stderr", UNREACHABLE_NOTICE);
        const restarted = await readyDaemon(env);
        restarted.releaseRuns();
        await chat.waitFor("stdout", `echo: ${LINE}`);
        chat.endInput();

        assert.equal(await exitedWithin(chat, "bob chat"), 0, chat.stderr());
        assert.equal(chat.stdout(), `echo: ${LINE}\n`);
        assert.deepEqual(await inputsOf(restarted), [LINE]);
    });
});

const TYPED_DURING_OUTAGE = "is anyone there?";
const SECOND_DURING_OUTAGE = "and now?";

/** An open chat whose daemon was killed: the notice is on standard error and the line `LINE` was admitted before. */
async function chatInOutage(): Promise<{ env: HermeticEnv; chat: PtySession; first: DaemonProcess }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const first = await readyDaemon(env);
    const chat = runInPty(["chat"], { runtimeDir: env.runtimeDir });
    sessions.push(chat);
    await chat.waitFor("output", PROMPT);
    chat.write(`${LINE}\r`);
    await until(async () => (await entriesText(first)).includes(LINE), "the line to reach the front desk");
    first.kill9();
    await first.exited;
    await chat.waitFor("stderr", UNREACHABLE_NOTICE);
    return { env, chat, first };
}

async function ptyExitedWithin(session: PtySession): Promise<number | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bob chat did not exit; stderr ${session.stderr()}`)), WAIT_MS);
    });
    try {
        return await Promise.race([session.exited, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

describe("bob chat used during a daemon outage", {
    skip: !hasScript() && !process.env.CI ? SKIP_REASON : false,
}, () => {
    it("keeps a typed line and admits it once, in order, when the daemon is back", async () => {
        const { env, chat } = await chatInOutage();

        chat.write(`${TYPED_DURING_OUTAGE}\r`);
        chat.write(`${SECOND_DURING_OUTAGE}\r`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(await Promise.race([chat.exited, Promise.resolve("running")]), "running", chat.stderr());
        const restarted = await readyDaemon(env);
        restarted.releaseRuns();
        await chat.waitFor("output", `echo: ${SECOND_DURING_OUTAGE}`);
        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        assert.deepEqual(await inputsOf(restarted), [LINE, TYPED_DURING_OUTAGE, SECOND_DURING_OUTAGE]);
        assert.equal(occurrences(chat.stderr(), UNREACHABLE_NOTICE), 1, chat.stderr());
    });

    it("keeps trying the abort, then names the line it dropped", async () => {
        const { env, chat } = await chatInOutage();

        chat.write(`${TYPED_DURING_OUTAGE}\r`);
        chat.write(CTRL_C);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(await Promise.race([chat.exited, Promise.resolve("running")]), "running", chat.stderr());
        await readyDaemon(env);
        await chat.waitFor("stderr", `Dropped, not answered: ${TYPED_DURING_OUTAGE}`);
        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
    });

    it("leaves on Ctrl-D with exit 0 and names the line that was never admitted", async () => {
        const { chat } = await chatInOutage();

        chat.write(`${TYPED_DURING_OUTAGE}\r`);
        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        assert.ok(chat.stderr().includes(TYPED_DURING_OUTAGE), chat.stderr());
    });

    it("leaves on Ctrl-D with exit 0 while an admitted line waits for its answer, and names the line", async () => {
        const { chat } = await chatInOutage();

        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        assert.ok(chat.stderr().includes(`The Intern went away; not answered: ${LINE}`), chat.stderr());
    });

    it("says the abort was not done when Ctrl-C and then Ctrl-D come during the outage", async () => {
        const { chat } = await chatInOutage();

        chat.write(CTRL_C);
        await new Promise((resolve) => setTimeout(resolve, 300));
        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        assert.ok(chat.stderr().includes("went away before the turn was stopped"), chat.stderr());
        assert.ok(chat.stderr().includes(`not answered: ${LINE}`), chat.stderr());
    });
});

describe("bob chat waiting for an answer after Ctrl-D", {
    skip: !hasScript() && !process.env.CI ? SKIP_REASON : false,
}, () => {
    async function chatWaitingAfterCtrlD(): Promise<{ chat: PtySession; daemon: DaemonProcess }> {
        const env = await createHermeticEnv();
        envs.push(env);
        const daemon = await readyDaemon(env);
        const chat = runInPty(["chat"], { runtimeDir: env.runtimeDir });
        sessions.push(chat);
        await chat.waitFor("output", PROMPT);
        chat.write(`${LINE}\r`);
        await until(async () => (await entriesText(daemon)).includes(LINE), "the line to reach the front desk");
        chat.write(CTRL_D);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await Promise.race([chat.exited, Promise.resolve("running")]), "running", chat.stderr());
        return { chat, daemon };
    }

    it("exits 0 and names the line when the daemon goes away during the wait", async () => {
        const { chat, daemon } = await chatWaitingAfterCtrlD();

        daemon.kill9();

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        assert.ok(chat.stderr().includes(`The Intern went away; not answered: ${LINE}`), chat.stderr());
    });

    it("stops the turn on Ctrl-C, names the dropped line and exits 0", async () => {
        const { chat, daemon } = await chatWaitingAfterCtrlD();

        chat.write(CTRL_C);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        assert.ok(chat.stderr().includes(`Dropped, not answered: ${LINE}`), chat.stderr());
        daemon.releaseRuns();
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal((await entriesText(daemon)).includes(`echo: ${LINE}`), false, "the aborted turn didn't answer");
    });
});

describe("bob chat restarted in the middle of an answer", {
    skip: !hasScript() && !process.env.CI ? SKIP_REASON : false,
}, () => {
    // pi-durable keeps what a killed response had written as an aborted entry, so the transcript holds that part and
    // the whole answer that follows; the screen shows each of the two once.
    it("shows the interrupted part and the whole answer, each once, when the daemon starts the response again", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const first = await readyDaemon(env, "streaming-gated");
        const chat = runInPty(["chat"], { runtimeDir: env.runtimeDir });
        sessions.push(chat);
        await chat.waitFor("output", PROMPT);
        chat.write(`${LONG_LINE}\r`);
        await chat.waitFor("output", "echo: tell");

        first.kill9();
        await first.exited;
        await chat.waitFor("stderr", UNREACHABLE_NOTICE);
        const restarted = await readyDaemon(env, "streaming-gated");
        restarted.releaseRuns();
        await chat.waitFor("output", `echo: ${LONG_LINE}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
        const rows = renderTerminal(chat.output()).rows;
        const answersOnScreen = rows.filter((row) => row.includes("echo: tell"));
        assert.equal(answersOnScreen.length, await assistantEntryCount(restarted), rows.join("\n"));
        assert.equal(rows.filter((row) => row === `echo: ${LONG_LINE}`).length, 1, rows.join("\n"));
    });
});

describe("bob chat and bob follow across a daemon restart", {
    skip: !hasScript() && !process.env.CI ? SKIP_REASON : false,
}, () => {
    it("prints a notice on standard error and keeps running when the daemon is killed and started again", async () => {
        const { chat, follow, restarted } = await restartWhileWaiting();
        restarted.releaseRuns();
        await chat.waitFor("output", `echo: ${LINE}`);

        assert.ok(chat.stderr().includes(UNREACHABLE_NOTICE), chat.stderr());
        assert.ok(follow.stderr().includes(UNREACHABLE_NOTICE), follow.stderr());
        const stillRunning = await Promise.race([
            chat.exited.then(() => false),
            follow.exited.then(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300)),
        ]);
        assert.ok(stillRunning, "neither command exits");
        chat.write(CTRL_D);
        assert.equal(await chat.exited, 0, chat.stderr());
    });

    it("prints the answer to the submitted line once after the restart", async () => {
        const { chat, restarted } = await restartWhileWaiting();
        assert.equal(chat.output().includes(`echo: ${LINE}`), false);

        restarted.releaseRuns();
        await chat.waitFor("output", `echo: ${LINE}`);
        await until(async () => occurrences(await entriesText(restarted), `echo: ${LINE}`) > 0, "the answer entry");
        await new Promise((resolve) => setTimeout(resolve, 500));
        chat.write(CTRL_D);

        assert.equal(await chat.exited, 0, chat.stderr());
        assert.equal(occurrences(chat.output(), `echo: ${LINE}`), 1, chat.output());
    });

    it("goes on printing new instance events after the restart", async () => {
        const { follow, restarted } = await restartWhileWaiting();
        const before = occurrences(follow.stdout(), " created ");

        await until(async () => {
            await restarted.invoke("jobs.create", { text: "after the restart" });
            return occurrences(follow.stdout(), " created ") > before;
        }, "the follow to print a job created after the restart");

        assert.equal(await Promise.race([follow.exited, Promise.resolve("running")]), "running");
    });
});

const UNAVAILABLE_NOTICE = "The Intern is starting or stopping; trying again";
const LONG_SLEEP_SECONDS = "60";

/** Starts a run that holds the daemon's stop open: a bash tool call that sleeps until the stop aborts it. */
async function startSleepingRun(daemon: DaemonProcess): Promise<void> {
    const { conversationId } = (await daemon.invoke("test.createConversation", { key: "one", cwd: "." })) as {
        conversationId: string;
    };
    await daemon.invoke("conversations.submit", {
        conversationId,
        content: LONG_SLEEP_SECONDS,
        requestId: "request-sleep",
    });
    await until(async () => {
        const { entries } = (await daemon.invoke("conversations.entries", { conversationId })) as {
            entries: { kind: string; data: unknown }[];
        };
        return entries.some((entry) => JSON.stringify(entry.data).includes("toolCall"));
    }, "the sleeping tool call");
}

const ANY_OUTAGE_NOTICE = /The Intern (isn't reachable|is starting or stopping); trying again/;

describe("bob follow across a daemon that stops and starts again", () => {
    it("prints a notice when the daemon is stopped with SIGTERM, waits, and goes on after it starts again", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const stopping = await readyDaemon(env, "bash-sleep");
        const follow = spawnBob(["follow"], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(follow);
        await waitUntilFollowing(stopping, follow);
        await startSleepingRun(stopping);

        stopping.signal("SIGTERM");
        await follow.waitFor("stderr", "trying again");
        await stopping.exited;
        const restarted = await readyDaemon(env, "bash-sleep");
        await waitUntilFollowing(restarted, follow);

        assert.match(follow.stderr(), ANY_OUTAGE_NOTICE);
        assert.equal(await Promise.race([follow.exited, Promise.resolve("running")]), "running");
    });

    it("prints the starting-or-stopping notice for a daemon that answers unavailable, and resumes when it is ready", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const starting = startDaemon({ hermetic: env, script: "bash-sleep", turnEndRule: false, holdStart: true });
        daemons.push(starting);
        // The socket opens while the start is held, and the daemon answers unavailable on it until it is released.
        await until(async () => existsSync(join(env.runtimeDir, "bob.sock")), "the held daemon to open its socket");
        const follow = spawnBob(["follow"], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(follow);

        await follow.waitFor("stderr", UNAVAILABLE_NOTICE);
        assert.equal(await Promise.race([follow.exited, Promise.resolve("running")]), "running");
        starting.release();
        await starting.ready;
        await waitUntilFollowing(starting, follow);

        assert.equal(await Promise.race([follow.exited, Promise.resolve("running")]), "running");
        assert.equal(follow.stderr(), `${UNAVAILABLE_NOTICE}\n`);
    });
});

/** A daemon whose start is held: it opens its socket and answers `unavailable` on it until the test releases it. */
async function heldDaemon(env: HermeticEnv): Promise<DaemonProcess> {
    const held = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, holdStart: true });
    daemons.push(held);
    await until(async () => existsSync(join(env.runtimeDir, "bob.sock")), "the held daemon to open its socket");
    return held;
}

async function isStillRunning(child: BobChild): Promise<boolean> {
    return (await Promise.race([child.exited, Promise.resolve("running")])) === "running";
}

describe("the following commands started while the daemon is starting", () => {
    it("makes bob follow keep trying, with the notice, when the daemon goes away after answering unavailable", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const held = await heldDaemon(env);
        const follow = spawnBob(["follow"], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(follow);
        await follow.waitFor("stderr", UNAVAILABLE_NOTICE);

        held.kill9();
        await held.exited;
        await new Promise((resolve) => setTimeout(resolve, 1500));

        assert.equal(await isStillRunning(follow), true, follow.stderr());
    });

    it("makes piped bob chat wait for the daemon, with the notice, and answer once it is ready", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const held = await heldDaemon(env);
        const chat = spawnBob(["chat"], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(chat);
        chat.write(`${LINE}\n`);
        chat.endInput();

        await chat.waitFor("stderr", UNAVAILABLE_NOTICE);
        assert.equal(await isStillRunning(chat), true, chat.stderr());
        held.release();

        assert.equal(await chat.exited, 0, chat.stderr());
        assert.equal(chat.stdout(), `echo: ${LINE}\n`);
        assert.equal(chat.stderr(), `${UNAVAILABLE_NOTICE}\n`);
    });

    it("makes bob jobs follow wait for the daemon, with the notice, and go on once it is ready", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const held = await heldDaemon(env);
        const follow = spawnBob(["jobs", "follow", "J-1"], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(follow);

        await follow.waitFor("stderr", UNAVAILABLE_NOTICE);
        assert.equal(await isStillRunning(follow), true, follow.stderr());
        held.release();
        await held.ready;

        // The daemon has no such job: the command got past the start, and the daemon's own answer ends it.
        assert.equal(await follow.exited, 1, follow.stderr());
        assert.ok(follow.stderr().includes("not_found"), follow.stderr());
    });

    it("makes bob chat on a terminal wait for the daemon, with the notice, and show its prompt once it is ready", {
        skip: !hasScript() && !process.env.CI ? SKIP_REASON : false,
    }, async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const held = await heldDaemon(env);
        const chat = runInPty(["chat"], { runtimeDir: env.runtimeDir });
        sessions.push(chat);

        await chat.waitFor("stderr", UNAVAILABLE_NOTICE);
        held.release();
        await chat.waitFor("output", PROMPT);
        chat.write(CTRL_D);

        assert.equal(await ptyExitedWithin(chat), 0, chat.stderr());
    });
});

describe("the following commands started with no daemon", () => {
    for (const args of [["chat"], ["follow"], ["jobs", "follow", "J-1"]]) {
        it(`makes bob ${args.join(" ")} say the daemon isn't running and exit 3`, async () => {
            const env = await createHermeticEnv();
            envs.push(env);
            const child = spawnBob(args, { runtimeDir: env.runtimeDir, env: env.env });
            children.push(child);
            child.endInput();

            assert.equal(await child.exited, 3, child.stderr());
            assert.ok(child.stderr().includes("isn't running here"), child.stderr());
        });
    }
});
