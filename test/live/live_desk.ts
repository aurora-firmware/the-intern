/**
 * Live check of S-001 Success Criterion 7 (live acceptance test 4) and S-005 Success Criterion 3: the front desk and
 * `bob chat` over the pi agent login of the account running this script, with one real model. Test 1 asks the front
 * desk for a piece of work and checks that it replies with the short number of a job whose origin names the front
 * desk. Test 2 pipes the same request to `bob chat` and runs `bob jobs follow` on the job it names, which must print
 * the job's activity until it is Done and exit 0. They make real model requests, so `npm test` never runs them; run
 * `npm run test:live:desk -- --model <provider/id>` by hand. The pi agent folder is the account's own: nothing here
 * writes to it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assistantText } from "../../src/cli/chat_terminal.ts";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const STOP_BOUND_MS = 30_000;
const SETTLE_TIMEOUT_MS = 300_000;
const FOLLOW_BOUND_MS = 300_000;
const REQUEST = "please write the word ready into a file named ready.txt";
const JOB_NUMBER = /\bC-[1-9][0-9]*\b/;

type LiveTest = { name: string; run(daemon: DaemonProcess, env: HermeticEnv): Promise<void> };
type Entry = { kind: string; data: unknown };

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

function jobNumberIn(text: string, source: string): string {
    const number = JOB_NUMBER.exec(text)?.[0];
    assert.ok(number, `${source} names no job number (C-n): ${JSON.stringify(text)}`);
    return number;
}

async function liveFrontDeskCreatesJobAndRepliesWithItsNumber(daemon: DaemonProcess): Promise<void> {
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content: REQUEST,
        requestId: "live-desk-request",
    })) as { submissionId: string };
    await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as {
        entries: Entry[];
    };
    const reply = entries
        .filter(({ kind }) => kind === "pi.assistant")
        .map((entry) => assistantText(entry))
        .join("\n");
    console.log(`  front desk reply: ${JSON.stringify(reply)}`);
    const number = jobNumberIn(reply, "the front desk's reply");

    const job = (await daemon.invoke("jobs.get", { job: number })) as JobView & {
        request: { origin: { kind: string; frontDesk?: string } };
    };
    console.log(`  job ${job.number} origin: ${JSON.stringify(job.request.origin)}`);
    assert.equal(job.request.origin.kind, "request");
    assert.equal(job.request.origin.frontDesk, conversationId, "the job's origin does not name the front desk");
}

async function liveBobChatCreatesJobAndFollowRunsToDone(daemon: DaemonProcess, env: HermeticEnv): Promise<void> {
    const options = { runtimeDir: env.runtimeDir, env: env.env };
    const chat = await runBob(["chat"], { ...options, stdin: `${REQUEST}\n` });
    console.log(`  bob chat exit ${chat.status}, stdout: ${JSON.stringify(chat.stdout)}`);
    assert.equal(chat.status, 0, `bob chat exited ${chat.status}: ${chat.stderr}`);
    const number = jobNumberIn(chat.stdout, "bob chat's output");

    const follow = await Promise.race([
        runBob(["jobs", "follow", number], options),
        new Promise<never>((_resolve, reject) => {
            setTimeout(
                () => reject(new Error(`bob jobs follow ${number} did not end in ${FOLLOW_BOUND_MS} ms`)),
                FOLLOW_BOUND_MS,
            ).unref();
        }),
    ]);
    console.log(`  bob jobs follow ${number} exit ${follow.status}, stdout:\n${follow.stdout}`);
    assert.equal(follow.status, 0, `bob jobs follow exited ${follow.status}: ${follow.stderr}`);
    const job = (await daemon.invoke("jobs.get", { job: number })) as JobView;
    assert.equal(job.status, "done", `job ${number} is ${job.status}, not done`);
}

const LIVE_TESTS: LiveTest[] = [
    {
        name: "the front desk creates a job and replies with its number",
        run: liveFrontDeskCreatesJobAndRepliesWithItsNumber,
    },
    {
        name: "bob chat creates a job and bob jobs follow runs it to Done",
        run: liveBobChatCreatesJobAndFollowRunsToDone,
    },
];

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

async function runLiveTest(test: LiveTest, model: string): Promise<void> {
    const env = await createLiveEnv();
    const daemon = startDaemon({ hermetic: env, realModels: true, model, turnEndRule: true });
    try {
        await daemon.ready;
        await test.run(daemon, env);
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
