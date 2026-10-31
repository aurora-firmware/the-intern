import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const SETTLE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const SLOW_DELAY_MS = 1_500;
const DEFAULT_WORKER_THREADS = 32;

type Waiting = { conversationId: string; position: number };
type Status = { workerThreads: { count: number; inUse: number; waiting: Waiting[] } };

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

function start(env: HermeticEnv, workerThreads?: number): DaemonProcess {
    const daemon = startDaemon({
        hermetic: env,
        script: "slow",
        delayMs: SLOW_DELAY_MS,
        ...(workerThreads !== undefined && { workerThreads }),
    });
    daemons.push(daemon);
    return daemon;
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

async function statusOf(daemon: DaemonProcess): Promise<Status> {
    return (await daemon.invoke("daemon.status", {})) as Status;
}

async function conversationStatus(daemon: DaemonProcess, conversationId: string): Promise<string> {
    return ((await daemon.invoke("conversations.get", { conversationId })) as { status: string }).status;
}

async function untilStatus(daemon: DaemonProcess, isWanted: (status: Status) => boolean, description: string) {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        const status = await statusOf(daemon);
        if (isWanted(status)) return status;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return assert.fail(`Timed out waiting for ${description}`);
}

/** Resolves with the time at which the submission settled as done. */
async function settledAt(daemon: DaemonProcess, submissionId: string): Promise<number> {
    const outcome = await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
    assert.deepEqual(outcome, { state: "done" });
    return Date.now();
}

/** Creates one conversation per name and submits to each in turn, so the arrival order is the name order. */
async function submitInOrder(daemon: DaemonProcess, names: string[]) {
    const runs: { conversationId: string; submissionId: string }[] = [];
    for (const name of names) {
        const conversationId = await createConversation(daemon, name);
        runs.push({ conversationId, submissionId: await submit(daemon, conversationId, name) });
    }
    return runs;
}

function assertIncreasing(times: number[]): void {
    for (let index = 1; index < times.length; index++)
        assert.ok(times[index] > times[index - 1], `settled times are not in arrival order: ${times.join(", ")}`);
}

describe("one worker thread", () => {
    it("finishes three conversations one after another in arrival order", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = start(await hermetic(), 1);
        await daemon.ready;
        const runs = await submitInOrder(daemon, ["a", "b", "c"]);

        const times = await Promise.all(runs.map((run) => settledAt(daemon, run.submissionId)));

        assertIncreasing(times);
    });
});

describe("kill -9 with one run active and two waiting", () => {
    it("finishes the active run, then the waiting ones in stored order", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, 1);
        await first.ready;
        const runs = await submitInOrder(first, ["a", "b", "c"]);
        const before = await untilStatus(first, (s) => s.workerThreads.waiting.length === 2, "two waiting runs");
        first.kill9();
        await first.exited;

        const second = start(env, 1);
        await second.ready;
        const resumed = await untilStatus(second, (s) => s.workerThreads.inUse === 1, "the active run to resume");

        assert.equal(resumed.workerThreads.inUse, 1);
        assert.deepEqual(
            resumed.workerThreads.waiting.map((waiter) => waiter.conversationId),
            before.workerThreads.waiting.map((waiter) => waiter.conversationId),
        );
        const times = await Promise.all(runs.map((run) => settledAt(second, run.submissionId)));
        assertIncreasing(times);
    });
});

describe("a lower worker-thread count after a stop", () => {
    it("keeps the extra run waiting at the head of the queue", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, 2);
        await first.ready;
        const runs = await submitInOrder(first, ["a", "b"]);
        await untilStatus(first, (s) => s.workerThreads.inUse === 2, "two active runs");
        first.signal("SIGTERM");
        await first.exited;

        const second = start(env, 1);
        await second.ready;
        const resumed = await untilStatus(second, (s) => s.workerThreads.waiting.length === 1, "one waiting run");

        assert.equal(resumed.workerThreads.count, 1);
        assert.equal(resumed.workerThreads.inUse, 1);
        assert.equal(resumed.workerThreads.waiting[0].position, 1);
        await Promise.all(runs.map((run) => settledAt(second, run.submissionId)));
    });
});

describe("runs waiting for a worker thread", () => {
    it("are reported with their positions by daemon.status and conversations.get", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = start(await hermetic(), 1);
        await daemon.ready;
        const runs = await submitInOrder(daemon, ["a", "b", "c"]);

        const status = await untilStatus(daemon, (s) => s.workerThreads.waiting.length === 2, "two waiting runs");

        assert.equal(status.workerThreads.count, 1);
        assert.equal(status.workerThreads.inUse, 1);
        assert.deepEqual(status.workerThreads.waiting, [
            { conversationId: runs[1].conversationId, position: 1 },
            { conversationId: runs[2].conversationId, position: 2 },
        ]);
        assert.equal(await conversationStatus(daemon, runs[1].conversationId), "waiting for a worker thread");
        assert.equal(await conversationStatus(daemon, runs[2].conversationId), "waiting for a worker thread");
        assert.equal(await conversationStatus(daemon, runs[0].conversationId), "running");
    });
});

describe("no worker-thread switch", () => {
    it("reports 32 worker threads in daemon.status", { timeout: TEST_TIMEOUT_MS }, async () => {
        const daemon = start(await hermetic());
        await daemon.ready;

        assert.equal((await statusOf(daemon)).workerThreads.count, DEFAULT_WORKER_THREADS);
    });
});
