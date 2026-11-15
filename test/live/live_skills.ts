/**
 * Live check of S-008 Success Criterion 6 (AC-008.3): skills over the pi agent login of the account running this
 * script, with one real model. A skill `lint` sits in a search path. The front desk is asked how to add a skill search
 * path: its transcript must show a `skill` call for `about-the-intern` and an answer naming `bob skills add-path`. A `gp`
 * job is then asked to enable `lint` for itself through `bob` and use it: its transcript must show the `bob skills
 * enable` command in a `bash` call and a later `skill` call for `lint`. It makes real model requests, so `npm test`
 * never runs it; run `npm run test:live:skills -- --model <provider/id>` by hand. The pi agent folder is the account's
 * own: nothing here writes to it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assistantText } from "../../src/cli/chat_screen.ts";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const STOP_BOUND_MS = 30_000;
const SETTLE_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 500;
const WAIT_BOUND_MS = 600_000;
const ENTRIES_LIMIT = 500;
const SKILL_NAME = "lint";
const DESK_QUESTION = "How do I add a skill search path to The Intern? Answer from the manual, with the exact command.";
const JOB_REQUEST =
    `Enable the skill ${SKILL_NAME} for yourself through the bob command line, then load it with the skill tool and ` +
    "say in one sentence what it tells you.";

type Entry = { kind: string; data: unknown };
type ToolCall = { name: string; arguments: Record<string, unknown> };
type ContentPart = { type?: string; name?: string; arguments?: Record<string, unknown> };

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

/** The tool calls of a transcript in the order the agent made them. */
function toolCallsOf(entries: Entry[]): ToolCall[] {
    return entries
        .filter(({ kind }) => kind === "pi.assistant")
        .flatMap(({ data }) => (Array.isArray(data) ? data : []))
        .flatMap((message: { content?: unknown }) => (Array.isArray(message.content) ? message.content : []))
        .filter((part: ContentPart) => part.type === "toolCall" && typeof part.name === "string")
        .map((part: ContentPart) => ({ name: part.name as string, arguments: part.arguments ?? {} }));
}

const describeCalls = (calls: ToolCall[]) => calls.map((call) => `${call.name} ${JSON.stringify(call.arguments)}`);

async function writeLintSkill(folder: string): Promise<void> {
    // The service refuses a search path that other accounts can reach.
    await mkdir(folder, { mode: OWNER_ONLY_MODE });
    await chmod(folder, OWNER_ONLY_MODE);
    const skillFolder = join(folder, SKILL_NAME);
    await mkdir(skillFolder);
    await writeFile(
        join(skillFolder, "SKILL.md"),
        `---\nname: ${SKILL_NAME}\ndescription: How to check a file with the project's linter.\n---\n\n` +
            "# Lint\n\nTo check a file, run `npx biome check <file>` and read the report it prints.\n",
    );
}

async function liveFrontDeskAnswersFromTheManual(daemon: DaemonProcess): Promise<void> {
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content: DESK_QUESTION,
        requestId: "live-skills-desk-question",
    })) as { submissionId: string };
    await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
    const entries = await entriesOf(daemon, conversationId);
    const calls = toolCallsOf(entries);
    console.log(`  front desk tool calls: ${JSON.stringify(describeCalls(calls))}`);
    assert.ok(
        calls.some((call) => call.name === "skill" && call.arguments.name === "about-the-intern"),
        "the front desk's transcript shows no skill call for about-the-intern",
    );
    const reply = entries
        .filter(({ kind }) => kind === "pi.assistant")
        .map((entry) => assistantText(entry))
        .join("\n");
    console.log(`  front desk reply: ${JSON.stringify(reply)}`);
    assert.ok(reply.includes("bob skills add-path"), "the front desk's answer does not name bob skills add-path");
}

async function liveJobEnablesLintAndUsesIt(daemon: DaemonProcess): Promise<void> {
    const created = (await daemon.invoke("jobs.create", { text: JOB_REQUEST, role: "gp" })) as JobView;
    console.log(`  job ${created.number} created for gp`);
    const conversationId = created.leadConversation;
    assert.ok(conversationId, `job ${created.number} has no lead conversation`);
    const deadline = Date.now() + WAIT_BOUND_MS;
    let job = created;
    while (job.status !== "done" && job.status !== "blocked" && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        job = (await daemon.invoke("jobs.get", { job: created.number })) as JobView;
    }
    console.log(`  ended: job ${job.number}, status ${job.status}`);
    assert.equal(job.status, "done", `job ${job.number} ended ${job.status}, not done`);
    const calls = toolCallsOf(await entriesOf(daemon, conversationId));
    console.log(`  job tool calls: ${JSON.stringify(describeCalls(calls))}`);
    const enableAt = calls.findIndex(
        (call) => call.name === "bash" && String(call.arguments.command ?? "").includes("bob skills enable"),
    );
    assert.notEqual(enableAt, -1, "the job's transcript shows no bob skills enable command in a bash call");
    const isLoadedAfter = calls
        .slice(enableAt + 1)
        .some((call) => call.name === "skill" && call.arguments.name === SKILL_NAME);
    assert.ok(isLoadedAfter, `the job's transcript shows no skill call for ${SKILL_NAME} after the enable command`);
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
        const searchPath = join(env.root, "skills");
        await writeLintSkill(searchPath);
        await daemon.invoke("skills.paths.add", { path: searchPath });
        await liveFrontDeskAnswersFromTheManual(daemon);
        await liveJobEnablesLintAndUsesIt(daemon);
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
    const name = "live skills: the desk reads the manual and a gp job enables and uses lint";
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
