import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, ConfigValueError, loadConfig } from "../../src/config/config_file.ts";
import { createModelRuntime } from "../../src/models/model_runtime.ts";
import { checkEntry, fireKey, THINKING_LEVELS } from "../../src/schedules/schedule_model.ts";
import { scheduleSection } from "../../src/schedules/schedule_section.ts";
import { createHermeticEnv } from "../support/hermetic_env.ts";

const valid = { name: "nightly-backups", cron: "0 2 * * *", request: "Check the backups." };

const keyOfFailure = (table: unknown): string => {
    try {
        scheduleSection.parse(table);
    } catch (error) {
        assert.ok(error instanceof ConfigValueError, String(error));
        return error.key;
    }
    return assert.fail("parse accepted the table");
};

describe("scheduleSection", () => {
    it("parses_an_entry_with_its_optional_values_and_serializes_the_same_keys", () => {
        const table = {
            ...valid,
            role: "ops",
            model: "provider/model",
            thinking_level: "low",
            workspace: "/srv/infra",
        };
        const entries = scheduleSection.parse([table, { name: "b", cron: "* * * * *", request: "r" }]);
        assert.deepEqual(entries[0], {
            name: "nightly-backups",
            cron: "0 2 * * *",
            request: "Check the backups.",
            role: "ops",
            model: "provider/model",
            thinkingLevel: "low",
            workspace: "/srv/infra",
        });
        assert.deepEqual(entries[1], { name: "b", cron: "* * * * *", request: "r" });
        assert.deepEqual(scheduleSection.serialize(entries), [table, { name: "b", cron: "* * * * *", request: "r" }]);
    });

    it("defaults_to_no_entries", () => {
        assert.deepEqual(scheduleSection.defaults(), []);
    });

    it("refuses_a_value_that_breaks_a_rule_naming_the_entry_and_the_key", () => {
        const cases: [string, unknown, string][] = [
            ["unknown key", [{ ...valid, color: "red" }], "nightly-backups.color"],
            ["name with a space", [{ ...valid, name: "two words" }], "two words.name"],
            ["name starting with a hyphen", [{ ...valid, name: "-a" }], "-a.name"],
            ["name too long", [{ ...valid, name: "a".repeat(65) }], `${"a".repeat(65)}.name`],
            ["repeated name", [valid, valid], "nightly-backups.name"],
            ["bad cron", [{ ...valid, cron: "not cron" }], "nightly-backups.cron"],
            ["cron never due", [{ ...valid, cron: "0 0 31 2 *" }], "nightly-backups.cron"],
            ["empty request", [{ ...valid, request: "  " }], "nightly-backups.request"],
            ["missing request", [{ name: "a", cron: "* * * * *" }], "a.request"],
            ["relative workspace", [{ ...valid, workspace: "srv/infra" }], "nightly-backups.workspace"],
            ["unknown thinking level", [{ ...valid, thinking_level: "deep" }], "nightly-backups.thinking_level"],
            ["non-string role", [{ ...valid, role: 3 }], "nightly-backups.role"],
        ];
        for (const [label, table, key] of cases) assert.equal(keyOfFailure(table), key, label);
    });

    it("keeps_names_that_differ_only_in_case_apart", () => {
        const entries = scheduleSection.parse([valid, { ...valid, name: "Nightly-Backups" }]);
        assert.equal(entries.length, 2);
    });

    it("names_the_position_of_an_entry_without_a_name", () => {
        assert.equal(keyOfFailure([valid, { cron: "* * * * *", request: "r" }]), "2.name");
        assert.equal(keyOfFailure([{ cron: "bad", request: "r", name: 7 }]), "1.name");
        assert.equal(keyOfFailure([{ cron: "* * * * *", request: "r", color: "red" }]), "1.color");
    });

    it("tells_the_file_and_schedule_key_when_the_config_file_is_loaded", async () => {
        const directory = await mkdtemp(join(tmpdir(), "schedule-section-"));
        const file = join(directory, "config.toml");
        try {
            await writeFile(file, '[[schedule]]\nname = "a"\ncron = "bad"\nrequest = "r"\n');
            await assert.rejects(
                loadConfig(file, [scheduleSection]),
                (error) => error instanceof ConfigError && error.file === file && error.key === "schedule.a.cron",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("checkEntry", () => {
    it("returns_the_entry_for_a_valid_value", () => {
        assert.deepEqual(checkEntry({ ...valid, thinkingLevel: "off" }), { ...valid, thinkingLevel: "off" });
    });

    it("refuses_what_the_file_refuses", () => {
        assert.throws(() => checkEntry({ ...valid, cron: "0 0 31 2 *" }), ConfigValueError);
        assert.throws(() => checkEntry({ ...valid, thinkingLevel: "deep" }), ConfigValueError);
        assert.throws(() => checkEntry({ ...valid, workspace: "relative" }), ConfigValueError);
        assert.throws(() => checkEntry("text"), ConfigValueError);
    });
});

describe("fireKey", () => {
    it("joins_the_entry_and_the_due_time", () => {
        assert.equal(fireKey("nightly-backups", "2026-11-08T02:00"), "schedule:nightly-backups:2026-11-08T02:00");
    });
});

describe("THINKING_LEVELS", () => {
    it("holds_every_level_the_registered_models_report", async () => {
        const hermetic = await createHermeticEnv();
        const runtime = await createModelRuntime({ piAgentDir: hermetic.piAgentDir });
        try {
            const reported = new Set(runtime.listModels().flatMap((entry) => entry.thinkingLevels));
            assert.ok(reported.size > 0);
            for (const level of reported) assert.ok(THINKING_LEVELS.includes(level), `${level} is not listed`);
        } finally {
            await runtime.close();
            await hermetic.dispose();
        }
    });
});
