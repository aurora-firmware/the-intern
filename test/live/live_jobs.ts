/**
 * Live check of S-004 Success Criterion 2: a job's life over the pi agent login of the account running this script,
 * with one real model and the turn-end rule on. A clear request must end Done `completed` with a definition of done
 * and a justification; an unclear one must end Blocked with a reason, and an answer submitted to its lead must set it
 * In progress. They make real model requests, so `npm test` never runs them; run
 * `npm run test:live:jobs -- --model <provider/id>` by hand. The pi agent folder is the account's own: nothing here
 * writes to it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const POLL_INTERVAL_MS = 500;
const WAIT_BOUND_MS = 300_000;
const SETTLE_TIMEOUT_MS = 300_000;
const CLEAR_REQUEST = "Write the word ready into a file named ready.txt in your workspace";
const UNCLEAR_REQUEST = "Fix the bug";
const ANSWER = "The bug is in the login page: the submit button does nothing. Fix it and report back.";

type LiveTest = { name: string; run(daemon: DaemonProcess, model: string): Promise<void> };

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

async function jobOf(daemon: DaemonProcess, ref: string): Promise<JobView> {
    return (await daemon.invoke("jobs.get", { job: ref })) as JobView;
}

function printJob(label: string, job: JobView): void {
    console.log(`  ${label}: job ${job.number}, status ${job.status}`);
    console.log(`    definition of done: ${JSON.stringify(job.definitionOfDone)}`);
    console.log(`    resolution: ${job.resolution ? JSON.stringify(job.resolution) : "none"}`);
    console.log(`    blocked reason: ${job.blockedReason ? JSON.stringify(job.blockedReason) : "none"}`);
}

/** Polls the job until it is in one of the statuses, and fails with the last one seen when the bound passes. */
async function untilStatus(daemon: DaemonProcess, ref: string, statuses: JobView["status"][]): Promise<JobView> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    let job = await jobOf(daemon, ref);
    while (!statuses.includes(job.status)) {
        assert.ok(Date.now() < deadline, `Timed out: job ${job.number} is ${job.status}, not ${statuses.join(" or ")}`);
        await sleep(POLL_INTERVAL_MS);
        job = await jobOf(daemon, ref);
    }
    return job;
}

async function liveClearRequestEndsDone(daemon: DaemonProcess, model: string): Promise<void> {
    const created = (await daemon.invoke("jobs.create", { text: CLEAR_REQUEST, model })) as JobView;
    const job = await untilStatus(daemon, created.number, ["done", "blocked"]);
    printJob("clear request", job);
    assert.equal(job.status, "done", `the clear request's job ended ${job.status}, not done`);
    assert.equal(job.resolution?.kind, "completed");
    assert.ok(job.resolution.justification.trim(), "the job has no justification");
    assert.ok(job.definitionOfDone.trim(), "the job has no definition of done");
}

async function liveUnclearRequestBlocksThenAnswerResumes(daemon: DaemonProcess, model: string): Promise<void> {
    const created = (await daemon.invoke("jobs.create", { text: UNCLEAR_REQUEST, model })) as JobView;
    const blocked = await untilStatus(daemon, created.number, ["done", "blocked"]);
    printJob("unclear request", blocked);
    assert.equal(blocked.status, "blocked", `the unclear request's job ended ${blocked.status}, not blocked`);
    assert.ok(blocked.blockedReason?.trim(), "the blocked job has no reason");
    assert.ok(created.leadConversation, `job ${created.number} has no lead conversation`);

    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId: created.leadConversation,
        content: ANSWER,
        requestId: `live-jobs-answer-${created.number}`,
    })) as { submissionId: string };
    const resumed = await untilStatus(daemon, created.number, ["in_progress", "done"]);
    printJob("after the answer", resumed);
    assert.equal(resumed.status, "in_progress", `the answer left the job ${resumed.status}, not in_progress`);
    await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
    printJob("after the answer's turn", await jobOf(daemon, created.number));
}

const LIVE_TESTS: LiveTest[] = [
    { name: "a clear request ends Done completed", run: liveClearRequestEndsDone },
    {
        name: "an unclear request ends Blocked and an answer sets it In progress",
        run: liveUnclearRequestBlocksThenAnswerResumes,
    },
];

async function runLiveTest(test: LiveTest, model: string): Promise<void> {
    const env = await createLiveEnv();
    const daemon = startDaemon({ hermetic: env, realModels: true, model, turnEndRule: true });
    try {
        await daemon.ready;
        await test.run(daemon, model);
        daemon.signal("SIGTERM");
        const { code } = await daemon.exited;
        assert.equal(code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
    } finally {
        daemon.kill9();
        await daemon.exited;
        await env.dispose();
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { model: { type: "string" } } });
    if (!values.model) throw new Error("Pass the model as --model <provider/id>");
    let hasFailure = false;
    for (const test of LIVE_TESTS) {
        try {
            await runLiveTest(test, values.model);
            console.log(`PASS ${test.name}`);
        } catch (error) {
            hasFailure = true;
            console.log(`FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    process.exit(hasFailure ? 1 : 0);
}

await main();
