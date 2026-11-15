/**
 * A crash doesn't repeat a schedule fire (S-007 REQ-016, AC-016.1; Success Criterion 3). The child daemon kills itself
 * just after the job of the 02:00 fire commits (`jobCrashAt`), the clock of its schedules is the test clock
 * (`scheduleClock`), and a second child starts on the same instance. Restarting within the same minute opens a window
 * after the due time, which never reaches the key; the test clock set back before it does.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";
import {
    conversationsOf,
    disposeCrashTest,
    type HistoryEntry,
    hermetic,
    historyOf,
    type JobView,
    listingOf,
    TEST_TIMEOUT_MS,
    untilInProgress,
    untilKilled,
    untilStatus,
    untilTrue,
    userInputsWith,
} from "../support/jobs_crash_support.ts";

const ENTRY = "nightly";
const REQUEST_TEXT = "Run nightly.";
const MARKER_REQUEST_TEXT = "Run marker.";
const SETTLE_MS = 200;
const at = (hour: number, minute = 0, second = 0): string => new Date(2026, 10, 8, hour, minute, second).toISOString();

type RunItem = { kind: "run"; job: JobView } | { kind: "skip"; skip: { dueTime: string; reason: string } };

const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    await disposeCrashTest();
});

/** A child daemon whose schedules run on the test clock at `clockAt`, killed at the creation of a job when asked. */
function start(env: HermeticEnv, clockAt: string, shouldCrash = false): DaemonProcess {
    const daemon = startDaemon({
        hermetic: env,
        script: "echo",
        turnEndRule: false,
        scheduleClock: clockAt,
        ...(shouldCrash && { jobCrashAt: "job-created" as const }),
    });
    daemons.push(daemon);
    return daemon;
}

const entryToml = (name: string, cron: string, request: string): string =>
    `[[schedule]]\nname = "${name}"\ncron = "${cron}"\nrequest = "${request}"\n`;

const writeEntries = (env: HermeticEnv, ...entries: string[]) =>
    writeFile(join(env.configDir, "config.toml"), entries.join(""));

const nightlyEntry = entryToml(ENTRY, "0 2 * * *", REQUEST_TEXT);

const setClock = (daemon: DaemonProcess, time: string) => daemon.invoke("test.setClock", { time });

/** The entry's history, found by item kind: a run and a skip at one minute are not told apart by position. */
const itemsOf = async (daemon: DaemonProcess, entry: string): Promise<RunItem[]> =>
    ((await daemon.invoke("schedules.runs", { name: entry })) as { items: RunItem[] }).items;

const runsOf = async (daemon: DaemonProcess, entry: string): Promise<JobView[]> =>
    (await itemsOf(daemon, entry)).flatMap((item) => (item.kind === "run" ? [item.job] : []));

const skipsOf = async (daemon: DaemonProcess, entry: string) =>
    (await itemsOf(daemon, entry)).flatMap((item) => (item.kind === "skip" ? [item.skip] : []));

const repairRulesOf = async (daemon: DaemonProcess, job: string): Promise<number[]> =>
    (await historyOf(daemon, job))
        .filter((entry: HistoryEntry) => entry.field === "repair")
        .map((entry) => (entry.new as { rule: number }).rule);

/** Starts a daemon whose clock is at 01:59, moves it to 02:00 and waits for the kill at the creation of the job. */
async function crashAtTheFire(env: HermeticEnv): Promise<void> {
    await writeEntries(env, nightlyEntry);
    const first = start(env, at(1, 59), true);
    await first.ready;
    await setClock(first, at(2)).catch(() => undefined);
    await untilKilled(first);
}

describe("kill -9 just after the job of a scheduled fire is created", () => {
    it("holds one job and starts its lead once when the daemon restarts within the same minute (AC-016.1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        await crashAtTheFire(env);

        const second = start(env, at(2, 0, 30));
        await second.ready;

        const jobs = await runsOf(second, ENTRY);
        assert.equal(jobs.length, 1);
        const [job] = jobs as [JobView];
        // Rule 1 seats the lead at startup; the job starts on the lead's admission grant, which may come after ready.
        await untilInProgress(second, job.id);
        assert.deepEqual(await repairRulesOf(second, job.id), [1]);
        const leads = (await conversationsOf(second, job.id)).filter((conversation) => conversation.isLead);
        assert.equal(leads.length, 1);
        const leadId = (leads[0] as { id: string }).id;
        await untilTrue(async () => (await userInputsWith(second, leadId, REQUEST_TEXT)) > 0, "the lead's first input");
        await untilStatus(second, leadId, "idle");
        assert.equal(await userInputsWith(second, leadId, REQUEST_TEXT), 1);
        assert.equal((await listingOf(second, leadId)).jobId, job.id);
    });

    it("holds one job when the clock is set back and reaches 02:00 again (AC-016.1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        await crashAtTheFire(env);
        // Both entries are due at 02:00, so the marker's job shows that the tick which reached the key has run.
        await writeEntries(env, nightlyEntry, entryToml("marker", "0 2 * * *", MARKER_REQUEST_TEXT));

        const second = start(env, at(1, 59));
        await second.ready;
        await setClock(second, at(2));
        await untilTrue(async () => (await runsOf(second, "marker")).length === 1, "the marker's fire");
        await sleep(SETTLE_MS);

        const jobs = await runsOf(second, ENTRY);
        assert.equal(jobs.length, 1);
        const [job] = jobs as [JobView];
        await untilInProgress(second, job.id);
        assert.equal((await conversationsOf(second, job.id)).filter((conversation) => conversation.isLead).length, 1);
        assert.deepEqual(await repairRulesOf(second, job.id), [1]);
        assert.deepEqual(await skipsOf(second, ENTRY), []);
    });
});

describe("kill -9 after a skipped fire", () => {
    it("holds one skipped fire when its due time passes again after the clock is set back (AC-016.1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        await writeEntries(env, nightlyEntry);
        const first = start(env, at(1, 59));
        await first.ready;
        await first.invoke("schedules.run", { name: ENTRY });
        await setClock(first, at(2));
        await untilTrue(async () => (await skipsOf(first, ENTRY)).length === 1, "the skipped fire");
        first.kill9();
        await first.exited;

        await writeEntries(env, nightlyEntry, entryToml("marker", "0 2 * * *", MARKER_REQUEST_TEXT));
        const second = start(env, at(1, 59));
        await second.ready;
        await setClock(second, at(2));
        await untilTrue(async () => (await runsOf(second, "marker")).length === 1, "the marker's fire");
        await sleep(SETTLE_MS);

        assert.equal((await skipsOf(second, ENTRY)).length, 1);
        assert.equal((await runsOf(second, ENTRY)).length, 1);
    });
});
