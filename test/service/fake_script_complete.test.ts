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
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";

type Entry = { kind: string; data: unknown };
type JobRecord = {
    id: string;
    status: string;
    resolution?: { kind: string };
    definitionOfDone?: string;
    leadConversation?: string;
};
type HistoryEntry = { field: string; new: unknown };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startOnScript(): Promise<DaemonProcess> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    const daemon = startDaemon({ hermetic: env, script: "invoke-and-complete" });
    daemons.push(daemon);
    await daemon.ready;
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

const jobOf = async (daemon: DaemonProcess, job: string): Promise<JobRecord> =>
    (await daemon.invoke("jobs.get", { job })) as JobRecord;

async function runToDone(daemon: DaemonProcess): Promise<{ job: JobRecord; leadId: string }> {
    const created = (await daemon.invoke("jobs.create", { text: "invoke and complete" })) as JobRecord;
    assert.ok(created.leadConversation, "the created job names its lead conversation");
    await untilTrue(async () => (await jobOf(daemon, created.id)).status === "done", "the job to be Done");
    return { job: await jobOf(daemon, created.id), leadId: created.leadConversation };
}

describe("the invoke-and-complete script", () => {
    it("ends the job Done with resolution completed after the lead took one agent's report", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = await startOnScript();
        const { job, leadId } = await runToDone(daemon);

        assert.equal(job.status, "done");
        assert.equal(job.resolution?.kind, "completed");
        const conversations = (await daemon.invoke("conversations.list", { jobId: job.id })) as { id: string }[];
        assert.equal(conversations.filter(({ id }) => id !== leadId).length, 1, "the lead invoked one agent");
    });

    it("records the definition of done and the completion in the history, and all three calls in the lead's transcript", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const daemon = await startOnScript();
        const { job, leadId } = await runToDone(daemon);

        const history = (await daemon.invoke("jobs.history.list", { job: job.id })) as { entries: HistoryEntry[] };
        assert.ok(
            history.entries.some((entry) => entry.field === "definitionOfDone"),
            "the definition of done",
        );
        assert.ok(
            history.entries.some((entry) => entry.field === "status" && entry.new === "done"),
            "the completion",
        );

        const { entries } = (await daemon.invoke("conversations.entries", {
            conversationId: leadId,
            limit: ENTRIES_LIMIT,
        })) as { entries: Entry[] };
        const transcript = JSON.stringify(entries);
        for (const toolName of ["update_job", "invoke", "complete_job"]) {
            assert.ok(transcript.includes(`"${toolName}"`), `the lead's transcript holds the ${toolName} call`);
        }
    });
});
