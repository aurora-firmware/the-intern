import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const EXIT_BOUND_MS = 10_000;
const LONG_SLEEP_SECONDS = "60";
const SHORT_SLEEP_SECONDS = "2";
const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const SETTLE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
const ENTRIES_LIMIT = 200;

type Entry = { kind: string; data: unknown };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

function start(env: HermeticEnv): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script: "bash-sleep" });
    daemons.push(daemon);
    return daemon;
}

async function exitWithin(daemon: DaemonProcess, boundMs: number) {
    const timeout = Symbol("timeout");
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), boundMs);
    });
    const outcome = await Promise.race([daemon.exited, bound]);
    clearTimeout(timer);
    assert.notEqual(outcome, timeout, `the daemon did not exit within ${boundMs} ms`);
    return outcome as Awaited<DaemonProcess["exited"]>;
}

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
        entries: Entry[];
    };
    return entries;
}

async function untilEntry(
    daemon: DaemonProcess,
    conversationId: string,
    isWanted: (entry: Entry) => boolean,
    description: string,
): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if ((await entriesOf(daemon, conversationId)).some(isWanted)) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const isToolCall = (entry: Entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes("toolCall");
const isToolResult = (entry: Entry) => entry.kind === "pi.tool-result";
const isFinalAnswer = (entry: Entry) => JSON.stringify(entry.data).includes("slept");

async function submitSleep(daemon: DaemonProcess, seconds: string) {
    const { conversationId } = (await daemon.invoke("test.createConversation", { key: "one", cwd: "." })) as {
        conversationId: string;
    };
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content: seconds,
        requestId: "request-sleep",
    })) as { submissionId: string };
    return { conversationId, submissionId };
}

async function settle(daemon: DaemonProcess, submissionId: string): Promise<unknown> {
    return daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
}

describe("SIGTERM during a bash tool call", () => {
    it("exits with status 0 within 10 seconds", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = start(await hermetic());
        await daemon.ready;
        const { conversationId } = await submitSleep(daemon, LONG_SLEEP_SECONDS);
        await untilEntry(daemon, conversationId, isToolCall, "the tool call");

        daemon.signal("SIGTERM");

        assert.deepEqual(await exitWithin(daemon, EXIT_BOUND_MS), { code: 0, signal: null });
    });

    it("resumes the run on restart with an interrupted result and settles once", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env);
        await first.ready;
        const { conversationId, submissionId } = await submitSleep(first, LONG_SLEEP_SECONDS);
        await untilEntry(first, conversationId, isToolCall, "the tool call");
        first.signal("SIGTERM");
        await exitWithin(first, EXIT_BOUND_MS);

        const second = start(env);
        await second.ready;

        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        const entries = await entriesOf(second, conversationId);
        const results = entries.filter(isToolResult);
        assert.equal(results.length, 1);
        assert.match(JSON.stringify(results[0].data), /interrupted/);
        assert.equal(entries.filter(isFinalAnswer).length, 1);
    });
});

describe("a storage failure during a run", () => {
    it("makes the daemon exit non-zero within 10 seconds", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = start(await hermetic());
        await daemon.ready;
        const { conversationId } = await submitSleep(daemon, SHORT_SLEEP_SECONDS);
        await untilEntry(daemon, conversationId, isToolCall, "the tool call");

        await daemon.invoke("test.failStorage", {});

        const { code } = await exitWithin(daemon, EXIT_BOUND_MS);
        assert.ok(code !== null && code !== 0, `expected a non-zero exit status, got ${code}`);
    });

    it("resumes the run from its last checkpoint on restart and settles once", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env);
        await first.ready;
        const { conversationId, submissionId } = await submitSleep(first, SHORT_SLEEP_SECONDS);
        await untilEntry(first, conversationId, isToolCall, "the tool call");
        await first.invoke("test.failStorage", {});
        await exitWithin(first, EXIT_BOUND_MS);

        const second = start(env);
        await second.ready;

        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        const entries = await entriesOf(second, conversationId);
        assert.equal(entries.filter(isToolCall).length, 1);
        assert.equal(entries.filter(isFinalAnswer).length, 1);
    });
});
