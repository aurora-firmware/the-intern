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

describe("resolvePiAgentDir", () => {
    it("returns_pi_coding_agent_dir_when_it_is_set", () => {
        assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "/somewhere/pi-agent" }), "/somewhere/pi-agent");
    });

    it("returns_the_pi_default_agent_dir_when_the_variable_is_unset", () => {
        assert.equal(resolvePiAgentDir({}), getAgentDir());
    });
});
