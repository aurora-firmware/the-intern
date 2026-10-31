/**
 * Live acceptance tests 1 and 2 of S-002: the daemon over the pi agent login of the account running this script, with
 * one real model. They make real model requests, so `npm test` never runs them; run `npm run test:live -- --model
 * <provider/id>` by hand. The pi agent folder is the account's own: nothing here writes to it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const POLL_INTERVAL_MS = 200;
const WAIT_BOUND_MS = 120_000;
const SETTLE_TIMEOUT_MS = 300_000;
const ENTRIES_LIMIT = 200;
const AUTH_FILE = "auth.json";

type Entry = { kind: string; data: unknown };
type LiveTest = { name: string; run(model: string): Promise<void> };

async function createLiveEnv(): Promise<HermeticEnv> {
    const root = resolve(".tmp", `live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
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

async function filesUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await filesUnder(path)));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}

async function hashesUnder(dir: string): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const path of await filesUnder(dir)) {
        hashes.set(
            path,
            createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
        );
    }
    return hashes;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
    const paths = new Set([...before.keys(), ...after.keys()]);
    return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

async function createConversation(daemon: DaemonProcess, key: string): Promise<string> {
    const { conversationId } = (await daemon.invoke("test.createConversation", { key, cwd: "." })) as {
        conversationId: string;
    };
    return conversationId;
}

async function submit(daemon: DaemonProcess, conversationId: string, content: string): Promise<string> {
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content,
        requestId: `request-${conversationId}`,
    })) as { submissionId: string };
    return submissionId;
}

function settle(daemon: DaemonProcess, submissionId: string): Promise<unknown> {
    return daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
}

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: ENTRIES_LIMIT })) as {
        entries: Entry[];
    };
    return entries;
}

/** Waits for a live `pi.tool` task: the tool call has started, so a kill lands during the long `bash` call. */
async function untilToolTaskLive(daemon: DaemonProcess, conversationId: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        const tasks = (await daemon.invoke("tasks.live", { conversationId })) as { kind: string }[];
        if (tasks.some((task) => task.kind === "pi.tool")) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
    }
    assert.fail("Timed out waiting for the bash tool task to be live");
}

function isFinalAnswer(entry: Entry): boolean {
    return entry.kind === "pi.assistant" && !JSON.stringify(entry.data).includes("toolCall");
}

/** One input, one interrupted tool result and one final answer after it: the run was not repeated after the restart. */
function assertRunSettledOnce(entries: Entry[]): void {
    const results = entries.filter((entry) => entry.kind === "pi.tool-result");
    assert.equal(results.length, 1, `expected one tool result, found ${results.length}`);
    assert.match(JSON.stringify(results[0].data), /interrupted/);
    assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1, "the input was taken more than once");
    const resultIndex = entries.indexOf(results[0]);
    const answersAfterResult = entries.slice(resultIndex).filter(isFinalAnswer);
    assert.equal(answersAfterResult.length, 1, `expected one final answer, found ${answersAfterResult.length}`);
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
    daemon.signal("SIGTERM");
    const { code } = await daemon.exited;
    assert.equal(code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
}

async function withLiveEnv(run: (env: HermeticEnv) => Promise<void>): Promise<void> {
    const env = await createLiveEnv();
    try {
        await run(env);
    } finally {
        await env.dispose();
    }
}

async function liveAnswerLeavesLoginUnchanged(model: string): Promise<void> {
    await withLiveEnv(async (env) => {
        const before = await hashesUnder(env.piAgentDir);
        const daemon = startDaemon({ hermetic: env, realModels: true, model });
        try {
            await daemon.ready;
            const conversationId = await createConversation(daemon, "live-one");
            const submissionId = await submit(daemon, conversationId, "Reply with the single word: pong");
            assert.deepEqual(await settle(daemon, submissionId), { state: "done" });
            const answered = (await entriesOf(daemon, conversationId)).some((entry) => entry.kind === "pi.assistant");
            assert.ok(answered, "the conversation holds no assistant answer");
            await stopDaemon(daemon);
        } finally {
            daemon.kill9();
            await daemon.exited;
        }
        const changed = changedPaths(before, await hashesUnder(env.piAgentDir));
        const unexpected = changed.filter((path) => path !== join(env.piAgentDir, AUTH_FILE));
        assert.deepEqual(unexpected, [], "the daemon changed files in the pi agent folder");
    });
}

async function liveKillDuringBashSettlesOnce(model: string): Promise<void> {
    await withLiveEnv(async (env) => {
        const first = startDaemon({ hermetic: env, realModels: true, model, script: "bash-sleep" });
        let second: DaemonProcess | undefined;
        try {
            await first.ready;
            const conversationId = await createConversation(first, "live-two");
            const prompt =
                "Use the bash tool to run exactly `sleep 60`, once. Then reply with the word done. " +
                "If the tool result says it was interrupted, do not run it again: reply done.";
            const submissionId = await submit(first, conversationId, prompt);
            await untilToolTaskLive(first, conversationId);
            first.kill9();
            await first.exited;

            second = startDaemon({ hermetic: env, realModels: true, model, script: "bash-sleep" });
            await second.ready;
            assert.deepEqual(await settle(second, submissionId), { state: "done" });
            assert.deepEqual(await settle(second, submissionId), { state: "done" });
            assertRunSettledOnce(await entriesOf(second, conversationId));
        } finally {
            for (const daemon of [first, second]) {
                daemon?.kill9();
                await daemon?.exited;
            }
        }
    });
}

const LIVE_TESTS: LiveTest[] = [
    { name: "live 1: a prompt is answered and the pi agent folder is unchanged", run: liveAnswerLeavesLoginUnchanged },
    { name: "live 2: kill -9 during bash continues with an interrupted result", run: liveKillDuringBashSettlesOnce },
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
