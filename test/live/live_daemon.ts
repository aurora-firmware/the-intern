/**
 * Live acceptance tests 1 and 2 of S-002 and the live client check of S-003 (Success Criterion 4): the daemon over the
 * pi agent login of the account running this script, with one real model. They make real model requests, so `npm test` never runs them; run `npm run test:live -- --model
 * <provider/id>` by hand. The pi agent folder is the account's own: nothing here writes to it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Client, createClient, type FeedItem } from "../../src/client/client.ts";
import { defaultSocketPath, nodeTransport } from "../../src/client/node_transport.ts";
import type { ConversationView } from "../../src/host/host_observation.ts";
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
type Feed = AsyncGenerator<FeedItem, { end: string }>;

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

function clientOverSocket(env: HermeticEnv): Client {
    const socketPath = defaultSocketPath({ env: env.env, homeDir: env.root, runtimeDir: env.runtimeDir });
    return createClient(nodeTransport({ socketPath }));
}

function viewOf(item: FeedItem): ConversationView {
    return "snapshot" in item ? (item.snapshot as ConversationView) : (item.delta as { view: ConversationView }).view;
}

/** The text parts of an assistant entry's model messages. */
function answerText(entry: Entry): string {
    const messages = Array.isArray(entry.data) ? entry.data : [entry.data];
    const parts = messages.flatMap((message) => (message as { content?: unknown }).content ?? []) as {
        type?: string;
        text?: string;
    }[];
    return parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

/** Reads the feed until a view is idle with a final answer; returns that answer and how many deltas came first. */
async function untilAnswered(feed: Feed): Promise<{ answer: string; deltaCount: number }> {
    let deltaCount = 0;
    for (;;) {
        const item = await feed.next();
        if (item.done) assert.fail(`the feed ended ${item.value.end} before the run finished`);
        if ("delta" in item.value) deltaCount += 1;
        const view = viewOf(item.value);
        const answer = view.entries.findLast(isFinalAnswer);
        if (!view.busy && answer) return { answer: answerText(answer), deltaCount };
    }
}

/** Reads the feed to its end and returns the end's reason. */
async function endOf(feed: Feed): Promise<string> {
    for (;;) {
        const item = await feed.next();
        if (item.done) return item.value.end;
    }
}

async function liveClientStreamsAnswerThenStopped(model: string): Promise<void> {
    await withLiveEnv(async (env) => {
        const daemon = startDaemon({ hermetic: env, realModels: true, model });
        try {
            await daemon.ready;
            const client = clientOverSocket(env);
            const { conversationId } = (await client.invoke("jobs.startLead", {
                jobId: "live-three",
                firstInput: "Reply with the single word: pong",
                model,
            })) as { conversationId: string };
            const feed = client.subscribe({ scope: "conversation", conversationId });
            const { answer, deltaCount } = await untilAnswered(feed);
            assert.ok(deltaCount > 0, "the run finished before the feed streamed any delta");
            console.log(`  live 3: answer after ${deltaCount} deltas over the local socket: ${JSON.stringify(answer)}`);
            daemon.signal("SIGTERM");
            const end = await endOf(feed);
            console.log(`  live 3: the stream ended ${end}`);
            assert.equal(end, "stopped");
            const { code } = await daemon.exited;
            assert.equal(code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
        } finally {
            daemon.kill9();
            await daemon.exited;
        }
    });
}

const LIVE_TESTS: LiveTest[] = [
    { name: "live 1: a prompt is answered and the pi agent folder is unchanged", run: liveAnswerLeavesLoginUnchanged },
    { name: "live 2: kill -9 during bash continues with an interrupted result", run: liveKillDuringBashSettlesOnce },
    {
        name: "live 3: the client library over the local socket streams the answer and ends stopped",
        run: liveClientStreamsAnswerThenStopped,
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
