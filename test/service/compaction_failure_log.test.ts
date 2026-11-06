import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 20;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const ENTRIES_LIMIT = 200;

type Entry = { kind: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

async function startFailingSummaryDaemon(): Promise<DaemonProcess> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }),
    );
    const daemon = startDaemon({ hermetic: env, script: "long-output-failing-summary" });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

describe("a compaction that fails", () => {
    it("is logged to standard error with its conversation and the failure text", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = await startFailingSummaryDaemon();
        const job = (await daemon.invoke("jobs.create", { text: "make output" })) as { leadConversation: string };
        const conversationId = job.leadConversation;
        const entryKinds = async (): Promise<string[]> => {
            const { entries } = (await daemon.invoke("conversations.entries", {
                conversationId,
                limit: ENTRIES_LIMIT,
            })) as { entries: Entry[] };
            return entries.map((entry) => entry.kind);
        };
        await untilTrue(async () => (await entryKinds()).includes("pi.tool-result"), "the 1 MiB tool result");

        await daemon.invoke("conversations.submit", { conversationId, content: "second", requestId: "r2" });

        await untilTrue(async () => {
            try {
                const state = (await daemon.invoke("test.submissionState", { conversationId, requestId: "r2" })) as {
                    state: string;
                };
                return state.state === "unanswered";
            } catch {
                return false;
            }
        }, "the second input to settle unanswered");
        await untilTrue(async () => daemon.stderr().includes("ERROR"), "an ERROR line on standard error");
        const errorLine =
            daemon
                .stderr()
                .split("\n")
                .find((line) => line.includes("ERROR")) ?? "";
        assert.match(errorLine, /compaction failed/);
        assert.match(errorLine, /Summarization attempted to call a tool/);
        assert.ok(
            errorLine.includes(`conversation=${conversationId} `),
            `the line names the conversation: ${errorLine}`,
        );
    });
});
