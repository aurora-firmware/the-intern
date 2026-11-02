/**
 * Live acceptance tests 2 and 3 of S-001: seat changes and invocations over the pi agent login of the account running
 * this script, with one real model. Live test 1 (a scheduled job) waits for the schedules and triggers spec. They make
 * real model requests, so `npm test` never runs them; run `npm run test:live:agents -- --model <provider/id>` by
 * hand. Live test 2 runs through the service operations, since the command line does not exist yet (product owner
 * ruling, 2026-10-31). The pi agent folder is the account's own: nothing here writes to it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SEAT_RECORD_KIND } from "../../src/host/seating.ts";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const POLL_INTERVAL_MS = 500;
const WAIT_BOUND_MS = 300_000;
const SETTLE_TIMEOUT_MS = 300_000;
const ENTRIES_LIMIT = 200;
const FILE_NAME = "hello.txt";
const FILE_CONTENT = "hello from gp";

type Entry = { id: string; kind: string; data: unknown; seat?: { role: string } };
type LiveTest = { name: string; run(model: string): Promise<void> };

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

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
        entries: Entry[];
    };
    return entries;
}

async function untilTrue(description: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(POLL_INTERVAL_MS);
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const isFinalAnswer = (entry: Entry): boolean =>
    entry.kind === "pi.assistant" && !JSON.stringify(entry.data).includes("toolCall");

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
    daemon.signal("SIGTERM");
    const { code } = await daemon.exited;
    assert.equal(code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
}

async function withDaemon(model: string, run: (daemon: DaemonProcess) => Promise<void>): Promise<void> {
    const env = await createLiveEnv();
    const daemon = startDaemon({ hermetic: env, realModels: true, model });
    try {
        await daemon.ready;
        await run(daemon);
        await stopDaemon(daemon);
    } finally {
        daemon.kill9();
        await daemon.exited;
        await env.dispose();
    }
}

async function startLead(daemon: DaemonProcess, role: string, text: string, model: string) {
    const job = (await daemon.invoke("jobs.create", { text, role, model })) as JobView;
    assert.ok(job.leadConversation, `job ${job.number} has no lead conversation`);
    return { number: job.number, conversationId: job.leadConversation };
}

/** A lead's first turn ends with `complete_job`, not a final answer entry: the job's status tells it is over. */
async function untilJobDone(daemon: DaemonProcess, number: string): Promise<void> {
    await untilTrue(`job ${number} to be done`, async () => {
        const job = (await daemon.invoke("jobs.get", { job: number })) as JobView;
        return job.status === "done";
    });
}

async function liveSeatChangeAttributesAnswerToGp(model: string): Promise<void> {
    await withDaemon(model, async (daemon) => {
        const { number, conversationId } = await startLead(daemon, "bob", "Reply with the single word: ready", model);
        await untilJobDone(daemon, number);
        const seat = (await daemon.invoke("conversations.seat", { conversationId, role: "gp", model })) as {
            role: string;
            workspace: string;
        };
        assert.equal(seat.role, "gp");
        const prompt = `Create the file ${FILE_NAME} in your current directory containing exactly: ${FILE_CONTENT}. Then reply done.`;
        const { submissionId } = (await daemon.invoke("conversations.submit", {
            conversationId,
            content: prompt,
            requestId: "live-seat-request",
        })) as { submissionId: string };
        assert.deepEqual(await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS }), {
            state: "done",
        });
        const entries = await entriesOf(daemon, conversationId);
        const seatIndex = entries.findLastIndex((entry) => entry.kind === SEAT_RECORD_KIND);
        const answers = entries.slice(seatIndex).filter((entry) => entry.kind === "pi.assistant");
        assert.ok(answers.length > 0, "gp gave no answer after the seat change");
        assert.ok(
            answers.every((entry) => entry.seat?.role === "gp"),
            "an answer after the change is not attributed to gp",
        );
        const written = await readFile(join(seat.workspace, FILE_NAME), "utf8");
        assert.ok(written.includes(FILE_CONTENT), `${FILE_NAME} in ${seat.workspace} holds: ${written}`);
    });
}

const INVOKE_PROMPT =
    "Use the invoke tool exactly once, with then set to parked, to invoke two agents of role bob, both with " +
    "contextMode clean. The first agent's jobPrompt is: Reply with the single word: alpha. The second agent's " +
    "jobPrompt is: Reply with the single word: beta. Invoke nothing else. When the reports arrive, reply with the " +
    "word done after the second one.";

type Invocations = { invoked: { role: string | null }[] };

async function liveParkedInvocationDeliversBothReports(model: string): Promise<void> {
    await withDaemon(model, async (daemon) => {
        const { conversationId } = await startLead(daemon, "gp", INVOKE_PROMPT, model);
        await untilTrue("two invoked bob agents", async () => {
            const tree = (await daemon.invoke("conversations.invocations", { conversationId })) as Invocations;
            return tree.invoked.filter((agent) => agent.role === "bob").length === 2;
        });
        await untilTrue("the gp agent to continue after both reports", async () => {
            const entries = await entriesOf(daemon, conversationId);
            const firstCall = entries.findIndex((entry) => entry.kind === "pi.assistant" && !isFinalAnswer(entry));
            const afterCall = entries.slice(firstCall + 1);
            const reports = afterCall.filter((entry) => entry.kind === "intern.report");
            // The lead may end with `complete_job` instead of a final answer: any model turn after the last report
            // shows it continued.
            const lastReport = afterCall.findLastIndex((entry) => entry.kind === "intern.report");
            return (
                reports.length >= 2 && afterCall.slice(lastReport + 1).some((entry) => entry.kind === "pi.assistant")
            );
        });
    });
}

const LIVE_TESTS: LiveTest[] = [
    { name: "live 2: a seat change to gp attributes the next answer to gp", run: liveSeatChangeAttributesAnswerToGp },
    {
        name: "live 3: a parked gp agent continues after both bob reports",
        run: liveParkedInvocationDeliversBothReports,
    },
];

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { model: { type: "string" } } });
    if (!values.model) throw new Error("Pass the model as --model <provider/id>");
    let hasFailure = false;
    for (const test of LIVE_TESTS) {
        try {
            await test.run(values.model);
            console.log(`PASS ${test.name}`);
        } catch (error) {
            hasFailure = true;
            console.log(`FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    process.exit(hasFailure ? 1 : 0);
}

await main();
