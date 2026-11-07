/**
 * What the crash tests of the Jobs component share: a hermetic instance, child daemons that kill themselves at a
 * write point (`jobCrashAt`), and the reads that show the state a second daemon finds after the kill.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WritePoint } from "../../src/jobs/jobs_component.ts";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "./daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

export const TEST_TIMEOUT_MS = 90_000;
export const DAEMON_AUTHOR = { kind: "daemon" };
export const STOPPED_REASON = "stopped by a team member";
const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = 30_000;
const LIMIT = 200;
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";

export type Entry = { kind: string; data: unknown };
export type Listing = { id: string; jobId: string | null; isLead: boolean; status: string };
export type JobView = { id: string; status: string; blockedReason?: string; leadConversation?: string };
export type HistoryEntry = { field: string; old: unknown; new: unknown; author: unknown };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

/** Kills every daemon a test started and removes its instance: call it from `afterEach`. */
export async function disposeCrashTest(): Promise<void> {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
}

export async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    return env;
}

/** The turn-end rule is on only for the tests about it; elsewhere a lead's stop would block its job. */
export function start(
    env: HermeticEnv,
    script: FakeScript,
    jobCrashAt?: WritePoint,
    turnEndRule = false,
): DaemonProcess {
    const daemon = startDaemon({
        hermetic: env,
        script,
        turnEndRule,
        ...(jobCrashAt !== undefined && { jobCrashAt }),
    });
    daemons.push(daemon);
    return daemon;
}

export async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

export const listingOf = async (daemon: DaemonProcess, conversationId: string) =>
    (await daemon.invoke("conversations.get", { conversationId })) as Listing;

export const conversationsOf = async (daemon: DaemonProcess, jobId: string) =>
    (await daemon.invoke("conversations.list", { jobId })) as Listing[];

export const jobOf = async (daemon: DaemonProcess, job: string) =>
    (await daemon.invoke("jobs.get", { job })) as JobView;

export const historyOf = async (daemon: DaemonProcess, job: string) =>
    ((await daemon.invoke("jobs.history.list", { job, limit: LIMIT })) as { entries: HistoryEntry[] }).entries;

/** No pi-durable task of the conversation is live: no run, and no compaction. */
export async function assertNoRun(daemon: DaemonProcess, conversationId: string): Promise<void> {
    assert.deepEqual(await daemon.invoke("tasks.live", { conversationId }), [], `no task of ${conversationId} is live`);
}

export const entriesOf = async (daemon: DaemonProcess, conversationId: string) =>
    (
        (await daemon.invoke("conversations.entries", { conversationId, limit: LIMIT })) as {
            entries: Entry[];
        }
    ).entries;

export const userInputsWith = async (daemon: DaemonProcess, conversationId: string, text: string) =>
    (await entriesOf(daemon, conversationId)).filter(
        (entry) => entry.kind === "pi.user" && JSON.stringify(entry.data).includes(text),
    ).length;

/** The steer records of the text: one per input the daemon submitted to a running or idle lead. */
export const steersWith = async (daemon: DaemonProcess, conversationId: string, text: string) =>
    (await entriesOf(daemon, conversationId)).filter(
        (entry) => entry.kind === "intern.steer" && JSON.stringify(entry.data).includes(text),
    ).length;

export const untilStatus = (daemon: DaemonProcess, conversationId: string, status: string) =>
    untilTrue(async () => (await listingOf(daemon, conversationId)).status === status, `the lead to be ${status}`);

export async function createJob(daemon: DaemonProcess, text: string, idempotencyKey?: string): Promise<JobView> {
    const job = (await daemon.invoke("jobs.create", {
        text,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
    })) as JobView;
    assert.ok(job.leadConversation, "the created job names its lead conversation");
    return job;
}

/** Waits for the kill the switch sends, so the next daemon starts on a dead one's state. */
export async function untilKilled(daemon: DaemonProcess): Promise<void> {
    assert.equal((await daemon.exited).signal, "SIGKILL");
}

/** The job is Blocked as stopped, with the lead parked, no reminder submitted and the daemon the author. */
export async function assertBlockedAsStopped(daemon: DaemonProcess, job: JobView): Promise<void> {
    const leadId = job.leadConversation as string;
    const stored = await jobOf(daemon, job.id);
    assert.equal(stored.status, "blocked");
    assert.equal(stored.blockedReason, STOPPED_REASON);
    assert.equal((await listingOf(daemon, leadId)).status, "parked");
    const blocks = (await historyOf(daemon, job.id)).filter((entry) => entry.new === "blocked");
    assert.deepEqual(
        blocks.map((entry) => entry.author),
        [DAEMON_AUTHOR],
    );
    assert.equal(await steersWith(daemon, leadId, REMINDER_TEXT), 0, "no reminder was submitted");
    assert.equal(await userInputsWith(daemon, leadId, REMINDER_TEXT), 0, "the lead took no reminder");
}
