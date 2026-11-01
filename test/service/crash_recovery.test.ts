import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const SETTLE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const ENTRIES_LIMIT = 200;
const SLOW_DELAY_MS = 3_000;
const LONG_SLEEP_SECONDS = "60";

type Entry = { kind: string; data: unknown };
type ConversationSummary = { id: string; status: string };
type Status = { workerThreads: { inUse: number; waiting: unknown[] } };

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

function start(env: HermeticEnv, script: FakeScript, workerThreads?: number): DaemonProcess {
    const daemon = startDaemon({
        hermetic: env,
        script,
        delayMs: SLOW_DELAY_MS,
        ...(workerThreads !== undefined && { workerThreads }),
    });
    daemons.push(daemon);
    return daemon;
}

async function crash(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

async function createConversation(daemon: DaemonProcess, key: string): Promise<string> {
    const { conversationId } = (await daemon.invoke("test.createConversation", { key, cwd: "." })) as {
        conversationId: string;
    };
    return conversationId;
}

async function submit(daemon: DaemonProcess, conversationId: string, content: string): Promise<string> {
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content,
        requestId: `request-${content}`,
    })) as { submissionId: string };
    return submissionId;
}

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
        entries: Entry[];
    };
    return entries;
}

async function conversationsOf(daemon: DaemonProcess): Promise<ConversationSummary[]> {
    return (await daemon.invoke("conversations.list", {})) as ConversationSummary[];
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

async function settle(daemon: DaemonProcess, submissionId: string): Promise<unknown> {
    return daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
}

const isToolCall = (entry: Entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes("toolCall");
const isToolResult = (entry: Entry) => entry.kind === "pi.tool-result";
const mentions = (text: string) => (entry: Entry) =>
    entry.kind === "pi.assistant" && JSON.stringify(entry.data).includes(text);

// A follow-up or steer input is placed as its intern.steer entry, a plain input as pi.user.
const isUserInput = (entry: Entry) => entry.kind === "pi.user" || entry.kind === "intern.steer";

/** Waits until the run has taken its input and has no answer yet, which is the span of the model request. */
async function untilModelRequestInFlight(daemon: DaemonProcess, conversationId: string): Promise<void> {
    await untilEntry(daemon, conversationId, isUserInput, "the run to take its input");
    const entries = await entriesOf(daemon, conversationId);
    assert.equal(entries.filter((entry) => entry.kind === "pi.assistant").length, 0, "the model already answered");
}

async function submissionState(daemon: DaemonProcess, submissionId: string): Promise<string> {
    return ((await daemon.invoke("submissions.get", { submissionId })) as { state: string }).state;
}

describe("kill -9 during a model request", () => {
    it("resumes the run and settles its submission once", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "slow");
        await first.ready;
        const conversationId = await createConversation(first, "one");
        const submissionId = await submit(first, conversationId, "alpha");
        await untilModelRequestInFlight(first, conversationId);
        await crash(first);

        const second = start(env, "slow");
        await second.ready;

        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        const entries = await entriesOf(second, conversationId);
        assert.equal(entries.filter(mentions("echo: alpha")).length, 1);
    });
});

describe("kill -9 during a bash tool call", () => {
    it("resumes the run and gives the model an interrupted result", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "bash-sleep");
        await first.ready;
        const conversationId = await createConversation(first, "one");
        const submissionId = await submit(first, conversationId, LONG_SLEEP_SECONDS);
        await untilEntry(first, conversationId, isToolCall, "the tool call");
        await crash(first);

        const second = start(env, "bash-sleep");
        await second.ready;

        assert.deepEqual(await settle(second, submissionId), { state: "done" });
        const entries = await entriesOf(second, conversationId);
        const results = entries.filter(isToolResult);
        assert.equal(results.length, 1);
        assert.match(JSON.stringify(results[0].data), /interrupted/);
        assert.equal(entries.filter(mentions("slept")).length, 1);
    });
});

describe("kill -9 with follow-up inputs queued", () => {
    it("answers every queued input once", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "slow");
        await first.ready;
        const conversationId = await createConversation(first, "one");
        const contents = ["alpha", "beta", "gamma"];
        const submissionIds: string[] = [];
        for (const content of contents) submissionIds.push(await submit(first, conversationId, content));
        await untilModelRequestInFlight(first, conversationId);
        assert.equal(await submissionState(first, submissionIds[0]), "running");
        for (const queued of submissionIds.slice(1)) assert.notEqual(await submissionState(first, queued), "done");
        await crash(first);

        const second = start(env, "slow");
        await second.ready;

        for (const submissionId of submissionIds)
            assert.deepEqual(await settle(second, submissionId), { state: "done" });
        const entries = await entriesOf(second, conversationId);
        for (const content of contents) assert.equal(entries.filter(mentions(`echo: ${content}`)).length, 1, content);
    });
});

describe("kill -9 during an admission change", () => {
    it("keeps every run active or waiting and finishes them all", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "slow", 1);
        await first.ready;
        const conversationIds = [await createConversation(first, "one"), await createConversation(first, "two")];
        const submissionIds = [
            await submit(first, conversationIds[0], "alpha"),
            await submit(first, conversationIds[1], "beta"),
        ];
        const { workerThreads: beforeKill } = (await first.invoke("daemon.status", {})) as Status;
        assert.equal(beforeKill.inUse, 1, "the first run is not holding the worker thread");
        assert.equal(beforeKill.waiting.length, 1, "the second conversation is not waiting");
        await crash(first);

        const second = start(env, "slow", 1);
        await second.ready;

        const { workerThreads } = (await second.invoke("daemon.status", {})) as Status;
        assert.equal(workerThreads.inUse + workerThreads.waiting.length, 2);
        const statuses = (await conversationsOf(second)).map((conversation) => conversation.status);
        assert.deepEqual(statuses.toSorted(), ["running", "waiting for a worker thread"]);
        for (const submissionId of submissionIds)
            assert.deepEqual(await settle(second, submissionId), { state: "done" });
    });
});

describe("kill -9 during test.createConversation", () => {
    it("holds exactly one conversation after a retry with the same key", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "echo");
        await first.ready;
        const interrupted = first.invoke("test.createConversation", { key: "one", cwd: "." }).catch(() => undefined);
        // IPC messages are handled in order, so once the status answers the daemon has begun the create call.
        await first.invoke("daemon.status", {});
        await crash(first);
        await interrupted;

        const second = start(env, "echo");
        await second.ready;
        const { conversationId } = (await second.invoke("test.createConversation", { key: "one", cwd: "." })) as {
            conversationId: string;
        };

        const conversations = await conversationsOf(second);
        assert.deepEqual(
            conversations.map((conversation) => conversation.id),
            [conversationId],
        );
    });
});
