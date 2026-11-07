/**
 * The restart after an abort that named the lead of a Blocked job (S-001 AC-014.2; S-004 REQ-018 rule 2): the lead is
 * still parked for an answer, so the next start repairs nothing for the job.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const HISTORY_LIMIT = 200;
const BLOCK_TEXT = "block me";

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

function start(env: HermeticEnv): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script: "block-with-reason" });
    daemons.push(daemon);
    return daemon;
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const statusOf = async (daemon: DaemonProcess, conversationId: string) =>
    ((await daemon.invoke("conversations.get", { conversationId })) as { status: string }).status;

it("writes no repair history entry at the next start after an abort named the Blocked job's lead", {
    timeout: TEST_TIMEOUT_MS,
}, async () => {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }),
    );
    const first = start(env);
    await first.ready;
    const job = (await first.invoke("jobs.create", { text: BLOCK_TEXT })) as { id: string; leadConversation: string };
    await untilTrue(async () => (await statusOf(first, job.leadConversation)) === "parked", "the lead to park");

    await first.invoke("conversations.abort", { conversationId: job.leadConversation });
    first.kill9();
    await first.exited;
    const second = start(env);
    await second.ready;

    assert.equal(await statusOf(second, job.leadConversation), "parked");
    const history = (await second.invoke("jobs.history.list", { job: job.id, limit: HISTORY_LIMIT })) as {
        entries: { field: string }[];
    };
    assert.deepEqual(
        history.entries.filter((entry) => entry.field === "repair"),
        [],
    );
});
