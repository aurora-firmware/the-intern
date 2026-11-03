import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type BobChild, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { hasScript, type PtySession, runInPty } from "../support/pty.ts";

const CTRL_D = "\x04";
const LINE = "are you still there?";
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

async function readyDaemon(env: HermeticEnv): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env, script: "gated", turnEndRule: false });
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
