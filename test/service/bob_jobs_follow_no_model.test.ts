import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NOTICE_KIND, type NoticeRecord } from "../../src/host/model_wait.ts";
import { type BobChild, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_BOUND_MS = scaled(30_000);
const POLL_INTERVAL_MS = 20;
const TEST_TIMEOUT_MS = scaled(90_000);

type JobView = { id: string; number: string; leadConversation: string };
type Entry = { kind: string; data: unknown };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const children: BobChild[] = [];

afterEach(async () => {
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

/** A daemon whose isolated pi agent folder names no default model, so a job's lead has none. */
async function noModelDaemon(): Promise<{ env: HermeticEnv; daemon: DaemonProcess }> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.piAgentDir, "settings.json"), "{}");
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

async function noticeOf(daemon: DaemonProcess, conversationId: string): Promise<NoticeRecord | undefined> {
    const page = (await daemon.invoke("conversations.entries", { conversationId, limit: 100 })) as {
        entries: Entry[];
    };
    return page.entries.find((entry) => entry.kind === NOTICE_KIND)?.data as NoticeRecord | undefined;
}

async function untilNotice(daemon: DaemonProcess, conversationId: string): Promise<NoticeRecord> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        const notice = await noticeOf(daemon, conversationId);
        if (notice !== undefined) return notice;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return assert.fail("Timed out waiting for the notice entry");
}

describe("bob jobs follow on a job whose lead has no model", () => {
    it("prints the text of the notice the lead's transcript gets", { timeout: TEST_TIMEOUT_MS }, async () => {
        const { env, daemon } = await noModelDaemon();
        const job = (await daemon.invoke("jobs.create", { text: "wait for a model" })) as JobView;
        const child = spawnBob(["jobs", "follow", job.number], { runtimeDir: env.runtimeDir, env: env.env });
        children.push(child);

        const notice = await untilNotice(daemon, job.leadConversation);

        await child.waitFor("stdout", `[${job.leadConversation}] notice: ${notice.text}`);
    });
});
