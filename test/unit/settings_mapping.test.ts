import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAPPED_PI_SETTINGS, mapPiSettings } from "../../src/models/settings_mapping.ts";

const TRANSPORT_VALUES = ["auto", "sse", "websocket", "websocket-cached"];

describe("mapPiSettings", () => {
    it("maps_transport_to_stream_transport", () => {
        for (const transport of TRANSPORT_VALUES) {
            assert.deepEqual(mapPiSettings({ transport }), { stream: { transport } });
        }
    });

    it("maps_retry_enabled_to_retry_enabled", () => {
        assert.deepEqual(mapPiSettings({ retry: { enabled: false } }), { retry: { enabled: false } });
    });

    it("maps_retry_max_retries_to_retry_max_retries", () => {
        assert.deepEqual(mapPiSettings({ retry: { maxRetries: 5 } }), { retry: { maxRetries: 5 } });
    });

    it("maps_retry_base_delay_to_retry_base_delay", () => {
        assert.deepEqual(mapPiSettings({ retry: { baseDelayMs: 1500 } }), { retry: { baseDelayMs: 1500 } });
    });

    it("maps_retry_max_agent_delay_to_retry_max_agent_delay", () => {
        assert.deepEqual(mapPiSettings({ retry: { maxAgentDelayMs: 30000 } }), {
            retry: { maxAgentDelayMs: 30000 },
        });
    });

    it("maps_steering_mode_to_steering_mode", () => {
        assert.deepEqual(mapPiSettings({ steeringMode: "all" }), { steeringMode: "all" });
        assert.deepEqual(mapPiSettings({ steeringMode: "one-at-a-time" }), { steeringMode: "one-at-a-time" });
    });

    it("maps_follow_up_mode_to_follow_up_mode", () => {
        assert.deepEqual(mapPiSettings({ followUpMode: "all" }), { followUpMode: "all" });
        assert.deepEqual(mapPiSettings({ followUpMode: "one-at-a-time" }), { followUpMode: "one-at-a-time" });
    });

    it("maps_compaction_enabled_to_compaction_enabled", () => {
        assert.deepEqual(mapPiSettings({ compaction: { enabled: false } }), { compaction: { enabled: false } });
    });

    it("maps_compaction_reserve_tokens_to_compaction_reserve_tokens", () => {
        assert.deepEqual(mapPiSettings({ compaction: { reserveTokens: 8000 } }), {
            compaction: { reserveTokens: 8000 },
        });
    });

    it("maps_compaction_keep_recent_tokens_to_compaction_keep_recent_tokens", () => {
        assert.deepEqual(mapPiSettings({ compaction: { keepRecentTokens: 10000 } }), {
            compaction: { keepRecentTokens: 10000 },
        });
    });

    it("maps_provider_timeout_to_stream_timeout", () => {
        assert.deepEqual(mapPiSettings({ retry: { provider: { timeoutMs: 90000 } } }), {
            stream: { timeoutMs: 90000 },
        });
    });

    it("maps_provider_max_retries_to_stream_max_retries", () => {
        assert.deepEqual(mapPiSettings({ retry: { provider: { maxRetries: 2 } } }), { stream: { maxRetries: 2 } });
    });

    it("maps_provider_max_retry_delay_to_stream_max_retry_delay", () => {
        assert.deepEqual(mapPiSettings({ retry: { provider: { maxRetryDelayMs: 0 } } }), {
            stream: { maxRetryDelayMs: 0 },
        });
    });

    it("merges_settings_that_share_a_harness_group", () => {
        assert.deepEqual(mapPiSettings({ transport: "sse", retry: { provider: { timeoutMs: 1 }, maxRetries: 4 } }), {
            stream: { transport: "sse", timeoutMs: 1 },
            retry: { maxRetries: 4 },
        });
    });

    it("returns_an_empty_mapping_when_no_mapped_setting_is_present", () => {
        assert.deepEqual(mapPiSettings({}), {});
    });

    it("leaves_fields_out_when_values_have_the_wrong_type", () => {
        const wrong = {
            transport: "carrier-pigeon",
            steeringMode: true,
            followUpMode: 1,
            retry: { enabled: "yes", maxRetries: "3", baseDelayMs: -1, maxAgentDelayMs: Number.NaN, provider: "x" },
            compaction: { enabled: 1, reserveTokens: 1.5, keepRecentTokens: null },
        };
        assert.deepEqual(mapPiSettings(wrong), {});
    });

    it("keeps_valid_siblings_when_one_value_has_the_wrong_type", () => {
        assert.deepEqual(mapPiSettings({ retry: { enabled: "yes", maxRetries: 2 } }), { retry: { maxRetries: 2 } });
    });

    it("returns_an_empty_mapping_when_the_settings_are_not_an_object", () => {
        for (const input of [undefined, null, "text", 3, ["transport"]]) {
            assert.deepEqual(mapPiSettings(input), {});
        }
    });

    it("returns_no_field_for_settings_outside_the_mapping", () => {
        const unmapped = {
            defaultModel: "m",
            theme: "dark",
            httpIdleTimeoutMs: 1000,
            compaction: { modelOverrides: { "a/b": { reserveTokens: 1 } } },
            retry: { other: 1 },
        };
        assert.deepEqual(mapPiSettings(unmapped), {});
    });
});

describe("MAPPED_PI_SETTINGS", () => {
    it("lists_transport_retry_modes_compaction_and_stream_timeouts", () => {
        const pairs = MAPPED_PI_SETTINGS.map(({ piKey, harnessField }) => `${piKey} -> ${harnessField}`);
        for (const expected of [
            "transport -> stream.transport",
            "retry.enabled -> retry.enabled",
            "retry.maxRetries -> retry.maxRetries",
            "retry.baseDelayMs -> retry.baseDelayMs",
            "retry.maxAgentDelayMs -> retry.maxAgentDelayMs",
            "steeringMode -> steeringMode",
            "followUpMode -> followUpMode",
            "compaction.enabled -> compaction.enabled",
            "compaction.reserveTokens -> compaction.reserveTokens",
            "compaction.keepRecentTokens -> compaction.keepRecentTokens",
            "retry.provider.timeoutMs -> stream.timeoutMs",
        ]) {
            assert.ok(pairs.includes(expected), `missing ${expected}`);
        }
    });

    it("has_one_distinct_entry_per_pi_agent_key", () => {
        const keys = MAPPED_PI_SETTINGS.map((entry) => entry.piKey);
        assert.equal(new Set(keys).size, keys.length);
    });
});
