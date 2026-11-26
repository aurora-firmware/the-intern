import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NOTICE_KIND } from "../../src/host/model_wait.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { type FakeModelServer, MODEL_ID, startFakeModelServer } from "../install/fake_model_server.ts";
import { runBob, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const QUESTION = "what's blocked?";
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const BLOCKED_REASON = "which build is failing?";
const ESCAPE = String.fromCharCode(27);

type Fixture = { env: HermeticEnv; daemon: DaemonProcess };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const server of servers.splice(0)) await server.close();
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const LOOPBACK_DEFAULT = JSON.stringify({ defaultProvider: "loopback", defaultModel: MODEL_ID });
const servers: FakeModelServer[] = [];

// The fake model is registered in the daemon's first model runtime only, and a changed pi agent folder opens a new
// one, so the model that answers after the change is the folder's own `models.json` model on a loopback server.
const echoLastLine = (transcript: readonly { role: string; text: string }[]) =>
    `echo: ${transcript.findLast((message) => message.role === "user")?.text}`;

/** A daemon whose isolated pi agent folder names no default model, so the front desk has none. */
async function noModelDaemon(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const server = await startFakeModelServer(echoLastLine);
    servers.push(server);
    const models = {
        providers: {
            loopback: {
                baseUrl: server.baseUrl,
                api: "openai-completions",
                apiKey: "not-a-real-key",
                models: [{ id: MODEL_ID, reasoning: false }],
            },
        },
    };
    await writeFile(join(env.piAgentDir, "models.json"), JSON.stringify(models));
    await writeFile(join(env.piAgentDir, "settings.json"), "{}");
    const daemon = startDaemon({ hermetic: env, realModels: true, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

// A line a team member submits is recorded with its way in as a steer entry.
const STEER_KIND = "intern.steer";

type DeskEntry = { kind: string; data: unknown };

async function deskEntries(daemon: DaemonProcess): Promise<DeskEntry[]> {
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    const page = (await daemon.invoke("conversations.entries", { conversationId, limit: 100 })) as {
        entries: DeskEntry[];
    };
    return page.entries;
}

async function untilState(check: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + scaled(30_000);
    while (!(await check())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function blockedJob(daemon: DaemonProcess, text: string): Promise<void> {
    const created = (await daemon.invoke("jobs.create", { text })) as { id: string };
    const deadline = Date.now() + WAIT_MS;
    while (((await daemon.invoke("jobs.get", { job: created.id })) as { status: string }).status !== "in_progress") {
        assert.ok(Date.now() < deadline, `timed out waiting for ${created.id} to start`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    await daemon.invoke("test.blockJob", { job: created.id, reason: BLOCKED_REASON });
}

const chat = (fixture: Fixture, args: string[], stdin: string) =>
    runBob(["chat", ...args], { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env, stdin });

describe("bob chat without a terminal", () => {
    it("prints the front desk's answer and nothing else, and exits 0, with two jobs Blocked", async () => {
        const fixture = await readyDaemon();
        await blockedJob(fixture.daemon, "first blocked job");
        await blockedJob(fixture.daemon, "second blocked job");
        const blocked = (await fixture.daemon.invoke("jobs.list", { status: "blocked" })) as { jobs: unknown[] };
        assert.equal(blocked.jobs.length, 2);
        const result = await chat(fixture, [], `${QUESTION}\n`);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `echo: ${QUESTION}\n`);
    });

    it("prints no prompt, history or terminal control sequence across several lines", async () => {
        const fixture = await readyDaemon();
        const result = await chat(fixture, [], "first\nsecond\n");
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "echo: first\necho: second\n");
        assert.ok(!result.stdout.includes(ESCAPE));
    });

    it("prints each entries answer unchanged, one JSON value per line, with --json", async () => {
        const fixture = await readyDaemon();
        const result = await chat(fixture, ["--json"], `${QUESTION}\n`);
        assert.equal(result.status, 0, result.stderr);
        const lines = result.stdout.trimEnd().split("\n");
        assert.equal(lines.length, 1);
        const answer = JSON.parse(lines[0] as string) as { entries: { kind: string }[] };
        assert.ok(answer.entries.some((entry) => entry.kind === "pi.assistant"));
        assert.ok(JSON.stringify(answer).includes(`echo: ${QUESTION}`));
    });

    it("exits 3 at once when no daemon runs in the runtime directory", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const result = await runBob(["chat"], { runtimeDir: env.runtimeDir, env: env.env, stdin: `${QUESTION}\n` });
        assert.equal(result.status, 3, result.stderr);
        assert.equal(result.stdout, "");
    });
});

describe("bob chat without a terminal when the front desk has no model", () => {
    it("submits every line, prints the notice once on stderr and nothing on stdout, exits 1, and has the lines answered once a model is named (AC-010.4)", async () => {
        const { env, daemon } = await noModelDaemon();
        const status = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
        assert.notEqual(status.noDefaultModel, null);

        const result = await chat({ env, daemon }, [], "first\nsecond\n");

        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, `${status.noDefaultModel?.message}\n`);
        await untilState(
            async () => (await deskEntries(daemon)).some((entry) => entry.kind === NOTICE_KIND),
            "the front desk's notice",
        );
        const waiting = (await deskEntries(daemon)).filter(
            (entry) => entry.kind === STEER_KIND || entry.kind === NOTICE_KIND,
        );
        assert.deepEqual(
            waiting.map((entry) => entry.kind),
            [STEER_KIND, NOTICE_KIND, STEER_KIND],
        );
        for (const [entry, content] of [
            [waiting[0], "first"],
            [waiting[2], "second"],
        ] as const) {
            assert.deepEqual(entry?.data, {
                actor: { kind: "team_member", wayIn: "command line" },
                mode: "followUp",
                content,
            });
        }

        await writeFile(join(env.piAgentDir, "settings.json"), LOOPBACK_DEFAULT);
        await untilState(
            async () => ((await daemon.invoke("daemon.status", {})) as DaemonStatus).noDefaultModel === null,
            "the daemon to see the default model",
        );
        await untilState(
            async () => (await deskEntries(daemon)).some((entry) => entry.kind === "pi.assistant"),
            "the front desk's answer",
        );
        // The release is one run from the transcript: the model sees both lines, in order, and no line is sent again.
        const [request, ...later] = servers[0]?.requests() ?? [];
        assert.deepEqual(
            request?.map((message) => [message.role, message.text]),
            [
                ["user", "first"],
                ["user", "second"],
            ],
        );
        assert.deepEqual(later, []);
        assert.equal((await deskEntries(daemon)).filter((entry) => entry.kind === STEER_KIND).length, 2);
    });
});

describe("bob chat without a terminal when the reader of its output goes away", () => {
    it("exits 0 with no error output when standard output is closed before the answer", async () => {
        const fixture = await readyDaemon();
        const child = spawnBob(["chat"], {
            runtimeDir: fixture.env.runtimeDir,
            env: fixture.env.env,
            deadlineMs: WAIT_MS,
        });

        // Standard input stays open, as in `(echo a; sleep 1) | bob chat | true`.
        child.write(`${QUESTION}\n`);
        child.closeStdout();

        assert.equal(await child.exited, 0, child.stderr());
        assert.equal(child.stderr(), "");
    });
});
