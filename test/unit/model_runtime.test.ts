import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, type InternModels, resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const MODELS_JSON = {
    providers: {
        fixture: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
                { id: "plain-model", reasoning: false },
                { id: "thinking-model", reasoning: true },
            ],
        },
    },
};

const SETTINGS_JSON = {
    defaultProvider: "fixture",
    defaultModel: "thinking-model",
    defaultThinkingLevel: "high",
    steeringMode: "all",
    retry: { maxRetries: 7 },
};

const AUTH_JSON = { fixture: { type: "api_key", key: "stored-key" } };

/** A timer the test fires by hand: it records the period and whether it was stopped. */
function createManualTimer() {
    let tick: (() => Promise<void>) | undefined;
    const timer = {
        periodMs: undefined as number | undefined,
        stopped: false,
        schedule: (callback: () => Promise<void>, periodMs: number) => {
            tick = callback;
            timer.periodMs = periodMs;
            return () => {
                timer.stopped = true;
            };
        },
        fire: async () => {
            if (!tick) throw new Error("No timer was scheduled");
            await tick();
        },
    };
    return timer;
}

async function snapshotFolder(dir: string): Promise<Record<string, string>> {
    const snapshot: Record<string, string> = {};
    for (const name of (await readdir(dir)).sort()) {
        snapshot[name] = (await readFile(join(dir, name))).toString("base64");
    }
    return snapshot;
}

describe("model runtime", () => {
    let hermetic: HermeticEnv;
    let runtime: InternModels | undefined;

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
        await writeFile(join(hermetic.piAgentDir, "models.json"), JSON.stringify(MODELS_JSON));
        await writeFile(join(hermetic.piAgentDir, "settings.json"), JSON.stringify(SETTINGS_JSON));
        await writeFile(join(hermetic.piAgentDir, "auth.json"), JSON.stringify(AUTH_JSON), { mode: 0o600 });
    });

    afterEach(async () => {
        await runtime?.close();
        runtime = undefined;
        await hermetic.dispose();
    });

    it("lists_registry_models_with_thinking_levels", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        const listed = runtime.listModels();
        const plain = listed.find((entry) => entry.model === "fixture/plain-model");
        const thinking = listed.find((entry) => entry.model === "fixture/thinking-model");
        assert.deepEqual(plain?.thinkingLevels, ["off"]);
        assert.ok(thinking?.thinkingLevels.includes("off"));
        assert.ok(thinking?.thinkingLevels.includes("high"));
    });

    it("returns_harness_settings_mapped_from_settings_json", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        assert.deepEqual(runtime.harnessSettings, { steeringMode: "all", retry: { maxRetries: 7 } });
    });

    it("returns_empty_harness_settings_when_settings_json_is_missing", async () => {
        await rm(join(hermetic.piAgentDir, "settings.json"));
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        assert.deepEqual(runtime.harnessSettings, {});
        assert.equal(runtime.defaultChoice(), undefined);
    });

    it("reads_default_model_and_thinking_level_from_settings", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        assert.deepEqual(runtime.defaultChoice(), { model: "fixture/thinking-model", thinkingLevel: "high" });
    });

    it("accepts_a_known_model_with_a_supported_thinking_level", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        assert.deepEqual(runtime.checkModelChoice({ model: "fixture/thinking-model", thinkingLevel: "high" }), {
            ok: true,
        });
        assert.deepEqual(runtime.checkModelChoice({ model: "fixture/plain-model" }), { ok: true });
    });

    it("rejects_a_model_the_registry_does_not_have_naming_the_model", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        const result = runtime.checkModelChoice({ model: "fixture/missing-model" });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("fixture/missing-model"));
    });

    it("rejects_a_model_without_a_provider_prefix_naming_the_model", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        const result = runtime.checkModelChoice({ model: "plain-model" });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("plain-model"));
    });

    it("rejects_a_thinking_level_the_model_does_not_support_naming_the_level", async () => {
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        const result = runtime.checkModelChoice({ model: "fixture/plain-model", thinkingLevel: "high" });
        assert.equal(result.ok, false);
        assert.ok(!result.ok && result.reason.includes("high"));
    });

    it("creates_the_runtime_when_auth_json_is_missing", async () => {
        await rm(join(hermetic.piAgentDir, "auth.json"));
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        assert.ok(runtime.listModels().some((entry) => entry.model === "fixture/plain-model"));
    });

    it("writes_no_auth_json_into_a_pi_agent_folder_that_has_none", async () => {
        await rm(join(hermetic.piAgentDir, "auth.json"));
        const before = await snapshotFolder(hermetic.piAgentDir);
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        runtime.checkModelChoice({ model: "fixture/plain-model" });
        await runtime.models.getAvailable();
        await runtime.models.checkAuth("fixture");
        await runtime.close();
        runtime = undefined;
        assert.deepEqual(await snapshotFolder(hermetic.piAgentDir), before);
    });

    it("leaves_every_file_in_the_pi_agent_folder_byte_identical", async () => {
        const before = await snapshotFolder(hermetic.piAgentDir);
        runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        runtime.listModels();
        runtime.checkModelChoice({ model: "fixture/thinking-model", thinkingLevel: "high" });
        runtime.defaultChoice();
        await runtime.close();
        runtime = undefined;
        assert.deepEqual(await snapshotFolder(hermetic.piAgentDir), before);
    });
});

describe("model runtime re-read", () => {
    let hermetic: HermeticEnv;
    let runtime: InternModels | undefined;
    let timer: ReturnType<typeof createManualTimer>;
    let errors: Error[];

    async function open(): Promise<InternModels> {
        runtime = await createModelRuntime({
            piAgentDir: hermetic.piAgentDir,
            schedule: timer.schedule,
            onReadError: (error) => errors.push(error),
        });
        return runtime;
    }

    const writeSettings = (settings: object) =>
        writeFile(join(hermetic.piAgentDir, "settings.json"), JSON.stringify(settings));

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
        timer = createManualTimer();
        errors = [];
        await writeFile(join(hermetic.piAgentDir, "models.json"), JSON.stringify(MODELS_JSON));
        await writeFile(join(hermetic.piAgentDir, "settings.json"), JSON.stringify({}));
    });

    afterEach(async () => {
        await runtime?.close();
        runtime = undefined;
        await hermetic.dispose();
    });

    it("reads_the_folder_every_10_seconds", async () => {
        await open();
        assert.equal(timer.periodMs, 10_000);
    });

    it("reports_no_default_model_while_the_settings_name_none", async () => {
        const models = await open();
        assert.equal(models.noDefaultModel(), true);
        assert.equal(models.defaultChoice(), undefined);
    });

    it("notices_a_default_that_appears_and_calls_each_listener_once", async () => {
        const models = await open();
        let first = 0;
        let second = 0;
        models.onDefaultAppeared(() => first++);
        models.onDefaultAppeared(() => second++);
        await writeSettings(SETTINGS_JSON);
        assert.equal(models.noDefaultModel(), true, "nothing is read before the timer fires");
        await timer.fire();
        assert.equal(models.noDefaultModel(), false);
        assert.deepEqual(models.defaultChoice(), { model: "fixture/thinking-model", thinkingLevel: "high" });
        await timer.fire();
        assert.deepEqual([first, second], [1, 1]);
    });

    it("counts_a_named_default_the_registry_does_not_resolve", async () => {
        const models = await open();
        await writeSettings({ defaultProvider: "fixture", defaultModel: "unknown-model" });
        await timer.fire();
        assert.equal(models.noDefaultModel(), false);
    });

    it("stops_calling_a_listener_that_was_removed", async () => {
        const models = await open();
        let calls = 0;
        const remove = models.onDefaultAppeared(() => calls++);
        remove();
        await writeSettings(SETTINGS_JSON);
        await timer.fire();
        assert.equal(calls, 0);
    });

    it("notices_a_default_that_disappears", async () => {
        await writeSettings(SETTINGS_JSON);
        const models = await open();
        assert.equal(models.noDefaultModel(), false);
        await writeSettings({});
        await timer.fire();
        assert.equal(models.noDefaultModel(), true);
        assert.equal(models.defaultChoice(), undefined);
    });

    it("keeps_the_runtime_while_no_file_changed", async () => {
        const models = await open();
        const before = models.current();
        await timer.fire();
        assert.equal(models.current(), before);
    });

    it("opens_a_new_runtime_with_the_logins_when_auth_json_is_created", async () => {
        const models = await open();
        const before = models.current();
        await writeFile(join(hermetic.piAgentDir, "auth.json"), JSON.stringify(AUTH_JSON), { mode: 0o600 });
        await timer.fire();
        assert.notEqual(models.current(), before);
        assert.equal(models.models, models.current());
    });

    it("opens_a_new_runtime_when_models_json_changes_size", async () => {
        const models = await open();
        const before = models.current();
        const changed = {
            providers: { fixture: { ...MODELS_JSON.providers.fixture, models: [{ id: "only-model" }] } },
        };
        await writeFile(join(hermetic.piAgentDir, "models.json"), JSON.stringify(changed));
        await timer.fire();
        assert.notEqual(models.current(), before);
        const listed = models.listModels().map((entry) => entry.model);
        assert.ok(listed.includes("fixture/only-model"));
        assert.ok(!listed.includes("fixture/plain-model"));
    });

    it("keeps_the_state_and_reports_when_the_settings_cannot_be_read", async () => {
        await writeSettings(SETTINGS_JSON);
        const models = await open();
        await writeFile(join(hermetic.piAgentDir, "settings.json"), "{not json");
        await timer.fire();
        assert.equal(models.noDefaultModel(), false);
        assert.equal(errors.length, 1);
        assert.ok(errors[0]?.message.includes("not valid JSON"));
    });

    it("writes_nothing_into_the_pi_agent_folder_when_it_reads", async () => {
        await writeSettings(SETTINGS_JSON);
        const models = await open();
        const before = await snapshotFolder(hermetic.piAgentDir);
        await timer.fire();
        await timer.fire();
        assert.equal(models.noDefaultModel(), false);
        assert.deepEqual(await snapshotFolder(hermetic.piAgentDir), before);
    });

    it("stops_the_timer_on_close_and_reads_nothing_afterwards", async () => {
        const models = await open();
        let calls = 0;
        models.onDefaultAppeared(() => calls++);
        await models.close();
        assert.equal(timer.stopped, true);
        await writeSettings(SETTINGS_JSON);
        await timer.fire();
        assert.equal(models.noDefaultModel(), true);
        assert.equal(calls, 0);
    });
});

describe("resolvePiAgentDir", () => {
    it("returns_pi_coding_agent_dir_when_it_is_set", () => {
        assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "/somewhere/pi-agent" }), "/somewhere/pi-agent");
    });

    it("returns_the_pi_default_agent_dir_when_the_variable_is_unset", () => {
        assert.equal(resolvePiAgentDir({}), getAgentDir());
    });
});
