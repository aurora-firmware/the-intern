import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ServiceError } from "../../src/service/operations.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SMALL_WORKER_THREAD_COUNT = 3;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

function track(daemon: DaemonProcess): DaemonProcess {
    daemons.push(daemon);
    return daemon;
}

async function createAndSubmit(daemon: DaemonProcess, content: string): Promise<{ conversationId: string }> {
    const { conversationId } = (await daemon.invoke("test.createConversation", { key: "one", cwd: "." })) as {
        conversationId: string;
    };
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content,
        requestId: `request-${content}`,
    })) as { submissionId: string };
    const settled = await daemon.invoke("submissions.wait", { submissionId, timeoutMs: 20_000 });
    assert.deepEqual(settled, { state: "done" });
    return { conversationId };
}

describe("startDaemon", () => {
    it("resolves ready once daemon.status reports ready, in the hermetic directories", async () => {
        const env = await hermetic();
        const daemon = track(startDaemon({ hermetic: env, workerThreads: SMALL_WORKER_THREAD_COUNT }));

        await daemon.ready;

        const status = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
        assert.equal(status.phase, "ready");
        assert.deepEqual(status.instance, {
            configDir: env.configDir,
            stateDir: env.stateDir,
            dataDir: env.dataDir,
            runtimeDir: env.runtimeDir,
        });
        assert.equal(status.workerThreads.count, SMALL_WORKER_THREAD_COUNT);
        assert.ok(daemon.pid > 0);
    });

    it("rejects ready when the child exits before it is ready", async () => {
        const env = await hermetic();
        const daemon = track(startDaemon({ hermetic: env, checkModel: "nowhere/nothing" }));

        await assert.rejects(daemon.ready, /exited/);
        assert.equal((await daemon.exited).code, 1);
        assert.match(daemon.stderr(), /check models/);
    });
});

describe("DaemonProcess.invoke", () => {
    it("returns the result of the named operation run in the child", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic() }));
        await daemon.ready;

        const listed = (await daemon.invoke("conversations.list", {})) as { isFrontDesk: boolean }[];
        assert.deepEqual(
            listed.filter((conversation) => !conversation.isFrontDesk),
            [],
        );
    });

    it("rejects with the ServiceError code and message of a failing operation", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic() }));
        await daemon.ready;

        await assert.rejects(
            daemon.invoke("no.such.operation", {}),
            (error: unknown) =>
                error instanceof ServiceError &&
                error.code === "not_found" &&
                /no\.such\.operation/.test(error.message),
        );
    });

    it("answers a status request while a start hook still holds the start, and reaches ready after release", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic(), holdStart: true }));

        const held = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
        assert.equal(held.phase, "starting");
        daemon.release();
        await daemon.ready;

        assert.equal(((await daemon.invoke("daemon.status", {})) as DaemonStatus).phase, "ready");
    });
});

describe("the fake model", () => {
    it("answers a submitted input with the echo reply", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic(), script: "echo" }));
        await daemon.ready;

        const { conversationId } = await createAndSubmit(daemon, "hello there");

        const context = (await daemon.invoke("conversations.context", { conversationId })) as {
            kind: string;
            data: unknown;
        }[];
        assert.match(JSON.stringify(context), /echo: hello there/);
    });

    it("calls bash with the sleep and then answers when the script is bash-sleep", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic(), script: "bash-sleep" }));
        await daemon.ready;

        const { conversationId } = await createAndSubmit(daemon, "0.1");

        const context = JSON.stringify(await daemon.invoke("conversations.context", { conversationId }));
        assert.match(context, /sleep 0\.1/);
        assert.match(context, /slept/);
    });

    it("holds the answer back for the delay when the script is slow", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic(), script: "slow", delayMs: 600 }));
        await daemon.ready;

        const started = Date.now();
        await createAndSubmit(daemon, "late");

        assert.ok(Date.now() - started >= 600, "the answer arrived before the delay passed");
    });
});

describe("kill9", () => {
    it("reaches ready on the same directories and lists the earlier conversation", async () => {
        const env = await hermetic();
        const first = track(startDaemon({ hermetic: env }));
        await first.ready;
        const { conversationId } = await createAndSubmit(first, "remember me");

        first.kill9();
        assert.deepEqual(await first.exited, { code: null, signal: "SIGKILL" });
        const second = track(startDaemon({ hermetic: env }));
        await second.ready;

        const listed = (await second.invoke("conversations.list", {})) as { id: string; isFrontDesk: boolean }[];
        assert.deepEqual(
            listed.filter((conversation) => !conversation.isFrontDesk).map((conversation) => conversation.id),
            [conversationId],
        );
    });
});

describe("test.failStorage", () => {
    it("makes the child exit non-zero when the next commit fails", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic() }));
        await daemon.ready;

        await daemon.invoke("test.failStorage", {});
        await daemon.invoke("test.createConversation", { key: "doomed", cwd: "." }).catch(() => undefined);

        const { code } = await daemon.exited;
        assert.ok(code !== null && code !== 0, `expected a non-zero exit status, got ${code}`);
        assert.match(daemon.stderr(), /storage failed/);
    });
});

describe("signals", () => {
    it("stops the child with status 0 on SIGTERM", async () => {
        const daemon = track(startDaemon({ hermetic: await hermetic() }));
        await daemon.ready;

        daemon.signal("SIGTERM");

        assert.deepEqual(await daemon.exited, { code: 0, signal: null });
    });
});
