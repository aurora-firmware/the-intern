import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const TEST_TIMEOUT_MS = 90_000;
const SETTLE_TIMEOUT_MS = 30_000;
const FILE_MODE = 0o600;
const FAR_FUTURE_EXPIRY_MS = 4_102_444_800_000;

const API_KEY_SECRET = "secret-api-key-7f3a91c2d8";
const OAUTH_ACCESS_SECRET = "secret-oauth-access-b41e07aa56";
const OAUTH_REFRESH_SECRET = "secret-oauth-refresh-92cd3e10f4";
const SECRETS = [API_KEY_SECRET, OAUTH_ACCESS_SECRET, OAUTH_REFRESH_SECRET];

const AUTH_JSON = {
    "fixture-key": { type: "api_key", key: API_KEY_SECRET },
    "fixture-login": {
        type: "oauth",
        access: OAUTH_ACCESS_SECRET,
        refresh: OAUTH_REFRESH_SECRET,
        expires: FAR_FUTURE_EXPIRY_MS,
    },
};
const SETTINGS_JSON = { defaultProvider: "fixture-key", defaultModel: "plain-model" };
const MODELS_JSON = {
    providers: {
        "fixture-key": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: API_KEY_SECRET,
            models: [{ id: "plain-model", reasoning: false }],
        },
    },
};

let env: HermeticEnv;
const daemons: DaemonProcess[] = [];

beforeEach(async () => {
    env = await createHermeticEnv();
    const fixtures = { "auth.json": AUTH_JSON, "settings.json": SETTINGS_JSON, "models.json": MODELS_JSON };
    for (const [name, content] of Object.entries(fixtures)) {
        await writeFile(join(env.piAgentDir, name), JSON.stringify(content), { mode: FILE_MODE });
    }
});

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    await env.dispose();
});

async function filesUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await filesUnder(path)));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}

async function hashesUnder(dir: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const path of await filesUnder(dir)) {
        hashes[path] = createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
    }
    return hashes;
}

async function runAndStop(): Promise<void> {
    const daemon = startDaemon({ hermetic: env, script: "echo" });
    daemons.push(daemon);
    await daemon.ready;
    const { conversationId } = (await daemon.invoke("test.createConversation", { key: "credentials", cwd: "." })) as {
        conversationId: string;
    };
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId,
        content: "hello",
        requestId: "request-hello",
    })) as { submissionId: string };
    const outcome = await daemon.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS });
    assert.deepEqual(outcome, { state: "done" });
    daemon.signal("SIGTERM");
    const { code } = await daemon.exited;
    assert.equal(code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
}

async function stopAfterStart(): Promise<void> {
    const daemon = startDaemon({ hermetic: env, script: "echo" });
    daemons.push(daemon);
    await daemon.ready;
    daemon.signal("SIGTERM");
    await daemon.exited;
}

describe("a daemon over a pi agent folder with credentials", () => {
    it("leaves_every_pi_agent_file_byte_identical", { timeout: TEST_TIMEOUT_MS }, async () => {
        const before = await hashesUnder(env.piAgentDir);
        assert.equal(Object.keys(before).length, 3);

        await runAndStop();
        await stopAfterStart();

        assert.deepEqual(await hashesUnder(env.piAgentDir), before);
    });

    it("stores_no_credential_string_in_the_instance_directories", { timeout: TEST_TIMEOUT_MS }, async () => {
        await runAndStop();
        await stopAfterStart();

        const files = (
            await Promise.all([env.configDir, env.stateDir, env.dataDir, env.runtimeDir].map(filesUnder))
        ).flat();
        assert.ok(
            files.some((path) => path.endsWith("-wal") || path.endsWith(".sqlite") || path.endsWith(".db")),
            `no database file found among: ${files.join(", ")}`,
        );
        for (const path of files) {
            const bytes = await readFile(path);
            for (const secret of SECRETS) {
                assert.ok(!bytes.includes(secret), `${path} contains a credential string`);
            }
        }
    });
});
