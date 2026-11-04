import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SETTLE_TIMEOUT_MS = 20_000;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<{ env: HermeticEnv; daemon: DaemonProcess }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

async function finishOneRun(daemon: DaemonProcess): Promise<string> {
    const { conversationId } = (await daemon.invoke("test.createConversation", { key: "one", cwd: "." })) as {
        conversationId: string;
    };
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content: "hello",
        requestId: "request-hello",
    })) as { submissionId: string };
    const settled = await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
    assert.deepEqual(settled, { state: "done" });
    return conversationId;
}

describe("bob status", () => {
    it("reaches the daemon named by --runtime-dir and exits 0", async () => {
        const { env } = await readyDaemon();

        const result = await runBob(["status"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
    });

    it("reaches the daemon named by BOB_RUNTIME_DIR alone", async () => {
        const { env } = await readyDaemon();

        const result = await runBob(["status"], { env: { ...env.env, BOB_RUNTIME_DIR: env.runtimeDir } });

        assert.equal(result.status, 0, result.stderr);
    });

    it("uses the folder --runtime-dir names when BOB_RUNTIME_DIR names another", async () => {
        const { env } = await readyDaemon();

        const result = await runBob(["status"], {
            runtimeDir: env.runtimeDir,
            env: { ...env.env, BOB_RUNTIME_DIR: `${env.root}/elsewhere` },
        });

        assert.equal(result.status, 0, result.stderr);
    });

    it("says it isn't running and exits 3 when no daemon runs in the runtime directory", async () => {
        const env = await createHermeticEnv();
        envs.push(env);

        const result = await runBob(["status"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 3);
        assert.equal(result.stdout, "");
        assert.equal(
            result.stderr.trim(),
            `The Intern isn't running here (${env.runtimeDir}/bob.sock); start it with \`bob serve\``,
        );
    });

    it("prints the phase ready and the worker threads in use and waiting", async () => {
        const { env } = await readyDaemon();

        const result = await runBob(["status"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Phase:\s+ready/);
        assert.match(result.stdout, /Worker threads in use:\s+0/);
        assert.match(result.stdout, /Worker threads waiting:\s+0/);
    });

    it("prints exactly the answer of daemon.status with --json", async () => {
        const { env, daemon } = await readyDaemon();

        const result = await runBob(["status", "--json"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        const answer = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
        assert.deepEqual(JSON.parse(result.stdout), answer);
    });
});

describe("bob usage", () => {
    it("prints the finished run's usage per conversation and in total", async () => {
        const { env, daemon } = await readyDaemon();
        const conversationId = await finishOneRun(daemon);
        const total = (await daemon.invoke("usage.get", {})) as { models: Record<string, unknown> };
        const [modelName] = Object.keys(total.models);
        assert.ok(modelName, "the finished run recorded no model usage");

        const result = await runBob(["usage"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`Conversation ${conversationId}\\b`));
        assert.match(result.stdout, /Total/);
        assert.ok(result.stdout.includes(modelName), result.stdout);
    });

    it("prints the total and each conversation's usage.get answer unchanged with --json", async () => {
        const { env, daemon } = await readyDaemon();
        const conversationId = await finishOneRun(daemon);

        const result = await runBob(["usage", "--json"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 0, result.stderr);
        const listed = (await daemon.invoke("conversations.list", {})) as { id: string }[];
        assert.ok(
            listed.some((conversation) => conversation.id === conversationId),
            "the finished run's conversation is listed",
        );
        const conversations = Object.fromEntries(
            await Promise.all(
                listed.map(async ({ id }) => [id, await daemon.invoke("usage.get", { conversationId: id })] as const),
            ),
        );
        assert.deepEqual(JSON.parse(result.stdout), { total: await daemon.invoke("usage.get", {}), conversations });
    });
});
