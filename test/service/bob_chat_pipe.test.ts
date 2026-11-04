import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const QUESTION = "what's blocked?";
const WAIT_MS = 20_000;
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
