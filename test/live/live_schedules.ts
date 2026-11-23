/**
 * Live test 1 of S-001, moved to S-007 Success Criterion 5: a scheduled run over the pi agent login of the account
 * running this script, with one real model. An entry for the `bob` role with the cron `* * * * *` asks for a file in
 * `gp`'s workspace; the fire at the next whole minute must start a job with letter `S`, the file must appear, and the
 * lead's transcript must show a seat change to `gp` or an invocation of a `gp` agent. The entry is removed when the
 * first job has started, so a second minute adds nothing. It makes real model requests, so `npm test` never runs it;
 * run `npm run test:live:schedules -- --model <provider/id>` by hand. The pi agent folder is the account's own:
 * nothing here writes to it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import type { ScheduleRunItem } from "../../src/jobs/schedule_history.ts";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { roleWorkspacePath } from "../../src/workspaces/workspace_folder.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const POLL_INTERVAL_MS = 500;
const FIRE_WAIT_BOUND_MS = 120_000;
const WAIT_BOUND_MS = 300_000;
const STOP_BOUND_MS = 30_000;
const ENTRIES_LIMIT = 200;
const ENTRY_NAME = "live-schedule";
const CRON_EVERY_MINUTE = "* * * * *";
const FILE_NAME = "scheduled.txt";
const FILE_CONTENT = "hello from a scheduled run";
const REQUEST =
    `Create the file ${FILE_NAME} containing exactly: ${FILE_CONTENT}. The file must be in the workspace of the gp ` +
    "role, not in your own. Get it there by changing your seat to gp, or by invoking a gp agent to write it.";

type Entry = { id: string; kind: string; data: unknown; seat?: { role: string } };
type Invocations = { invoked: { role: string | null }[] };
type SeatRecordData = { next: { role: string } };

async function createLiveEnv(): Promise<HermeticEnv> {
    // A short path under the system temp folder: a socket path over 107 bytes fails in a deep worktree.
    const root = join(tmpdir(), `bob-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
    const directories = ["config", "state", "data", "runtime"].map((name) => join(root, name));
    await mkdir(root, { recursive: true, mode: OWNER_ONLY_MODE });
    await chmod(root, OWNER_ONLY_MODE);
    for (const directory of directories) {
        await mkdir(directory, { mode: OWNER_ONLY_MODE });
        await chmod(directory, OWNER_ONLY_MODE);
    }
    const piAgentDir = resolvePiAgentDir(process.env);
    const [configDir, stateDir, dataDir, runtimeDir] = directories;
    return {
        root,
        configDir,
        stateDir,
        dataDir,
        runtimeDir,
        piAgentDir,
        env: { ...process.env, HOME: process.env.HOME, PI_CODING_AGENT_DIR: piAgentDir },
        dispose: () => rm(root, { recursive: true, force: true }),
    };
}

const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function untilValue<T>(description: string, bound: number, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + bound;
    while (Date.now() < deadline) {
        const value = await read();
        if (value !== undefined) return value;
        await sleep(POLL_INTERVAL_MS);
    }
    return assert.fail(`Timed out waiting for ${description}`);
}

/** The newest job a fire of the entry started, found by kind: the history's order across offsets is B-034. */
async function firedJob(daemon: DaemonProcess): Promise<JobView | undefined> {
    const page = (await daemon.invoke("schedules.runs", { name: ENTRY_NAME })) as { items: ScheduleRunItem[] };
    const run = page.items.find((item) => item.kind === "run");
    if (run?.kind !== "run") return undefined;
    return (await daemon.invoke("jobs.get", { job: run.job.number })) as JobView;
}

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
        entries: Entry[];
    };
    return entries;
}

async function seatChangeToGp(daemon: DaemonProcess, conversationId: string): Promise<boolean> {
    const entries = await entriesOf(daemon, conversationId);
    return entries.some(
        (entry) => entry.kind === SEAT_RECORD_KIND && (entry.data as SeatRecordData).next.role === "gp",
    );
}

async function invokedGpAgents(daemon: DaemonProcess, conversationId: string): Promise<number> {
    const tree = (await daemon.invoke("conversations.invocations", { conversationId })) as Invocations;
    return tree.invoked.filter((agent) => agent.role === "gp").length;
}

async function liveScheduledRunWritesFileForGp(daemon: DaemonProcess, model: string, env: HermeticEnv): Promise<void> {
    await daemon.invoke("schedules.create", {
        name: ENTRY_NAME,
        cron: CRON_EVERY_MINUTE,
        request: REQUEST,
        role: "bob",
        model,
    });
    const started = await untilValue("the fire at the next whole minute", FIRE_WAIT_BOUND_MS, () => firedJob(daemon));
    await daemon.invoke("schedules.remove", { name: ENTRY_NAME });
    console.log(`  fired: job ${started.number}, status ${started.status}`);
    assert.match(started.number, /^S-\d+$/, `the scheduled job's number is ${started.number}, not S-n`);
    const conversationId = started.leadConversation;
    assert.ok(conversationId, `job ${started.number} has no lead conversation`);
    await untilValue(`job ${started.number} to end`, WAIT_BOUND_MS, async () => {
        const job = (await daemon.invoke("jobs.get", { job: started.number })) as JobView;
        return job.status === "done" || job.status === "blocked" ? job : undefined;
    });
    const job = (await daemon.invoke("jobs.get", { job: started.number })) as JobView;
    console.log(
        `  ended: job ${job.number}, status ${job.status}, blocked reason ${JSON.stringify(job.blockedReason)}`,
    );
    assert.equal(job.status, "done", `job ${job.number} ended ${job.status}, not done`);

    const path = join(roleWorkspacePath(env.dataDir, "gp"), FILE_NAME);
    const written = await readFile(path, "utf8");
    console.log(`  file ${path}: ${JSON.stringify(written)}`);
    assert.ok(written.includes(FILE_CONTENT), `${path} holds: ${written}`);

    const isSeatChange = await seatChangeToGp(daemon, conversationId);
    const invoked = await invokedGpAgents(daemon, conversationId);
    console.log(`  transcript: seat change to gp ${isSeatChange}, gp agents invoked ${invoked}`);
    assert.ok(isSeatChange || invoked > 0, "the transcript shows neither a seat change to gp nor a gp invocation");
}

/** Waits for the daemon to exit after SIGTERM; a daemon that does not exit in time fails the run, never hangs it. */
async function expectCleanExit(daemon: DaemonProcess): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolveWait) => {
        timer = setTimeout(() => resolveWait("timeout"), STOP_BOUND_MS);
    });
    try {
        const outcome = await Promise.race([daemon.exited, deadline]);
        if (outcome === "timeout") {
            daemon.kill9();
            assert.fail(`the daemon did not exit within ${STOP_BOUND_MS} ms of SIGTERM: ${daemon.stderr()}`);
        }
        assert.equal(outcome.code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
    } finally {
        clearTimeout(timer);
    }
}

async function runLive(model: string): Promise<void> {
    const env = await createLiveEnv();
    const daemon = startDaemon({ hermetic: env, realModels: true, model, turnEndRule: true });
    try {
        await daemon.ready;
        await liveScheduledRunWritesFileForGp(daemon, model, env);
        daemon.signal("SIGTERM");
        await expectCleanExit(daemon);
    } finally {
        daemon.kill9();
        await daemon.exited;
        await env.dispose();
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { model: { type: "string" } } });
    if (!values.model) throw new Error("Pass the model as --model <provider/id>");
    const name = "live 1: a scheduled run writes a file in gp's workspace";
    try {
        await runLive(values.model);
        console.log(`PASS ${name}`);
    } catch (error) {
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    process.exit(0);
}

await main();
