import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigError, ConfigValueError, defineConfigSection, loadConfig } from "../../src/config/config_file.ts";

type Limits = { max: number };

const limitsSection = defineConfigSection<Limits>({
    name: "limits",
    defaults: () => ({ max: 1 }),
    parse(table) {
        const entries = Object.entries(table as Record<string, unknown>);
        for (const [key, value] of entries) {
            if (key !== "max") throw new ConfigValueError(key, "unknown key");
            if (typeof value !== "number") throw new ConfigValueError(key, "must be a number");
        }
        return { max: (table as Limits).max ?? 1 };
    },
    serialize: (value) => ({ max: value.max }),
});

const namesSection = defineConfigSection<string[]>({
    name: "names",
    defaults: () => [],
    parse: () => ["parsed"],
    serialize: () => ({}),
});

describe("loadConfig", () => {
    let directory: string;
    let file: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "config-file-"));
        file = join(directory, "config.toml");
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it("returns every section's defaults with fingerprint absent when the file is missing", async () => {
        const loaded = await loadConfig(file, [limitsSection, namesSection]);
        assert.deepEqual(loaded.values.get("limits"), { max: 1 });
        assert.deepEqual(loaded.values.get("names"), []);
        assert.equal(loaded.fingerprint, "absent");
    });

    it("returns each section's parsed value and the SHA-256 of the bytes read", async () => {
        const text = "[limits]\nmax = 7\n";
        await writeFile(file, text);
        const loaded = await loadConfig(file, [limitsSection]);
        assert.deepEqual(loaded.values.get("limits"), { max: 7 });
        assert.equal(loaded.fingerprint, createHash("sha256").update(text).digest("hex"));
    });

    it("returns defaults for a registered section the file does not mention", async () => {
        await writeFile(file, "[limits]\nmax = 7\n");
        const loaded = await loadConfig(file, [limitsSection, namesSection]);
        assert.deepEqual(loaded.values.get("names"), []);
    });

    it("throws ConfigError naming the file, the reason and the line for invalid TOML", async () => {
        await writeFile(file, "[limits]\nmax = = 7\n");
        await assert.rejects(loadConfig(file, [limitsSection]), (error: unknown) => {
            assert.ok(error instanceof ConfigError);
            assert.equal(error.file, file);
            assert.ok(error.message.includes(file));
            assert.ok(error.reason.length > 0);
            assert.match(error.reason, /line 2/i);
            return true;
        });
    });

    it("throws ConfigError naming the file when the file can't be read", async () => {
        await assert.rejects(loadConfig(directory, [limitsSection]), (error: unknown) => {
            assert.ok(error instanceof ConfigError);
            assert.ok(error.message.includes(directory));
            assert.match(error.reason, /EISDIR/);
            return true;
        });
    });

    it("throws ConfigError naming the file and an unowned top-level key", async () => {
        await writeFile(file, "[limits]\nmax = 2\n\n[stray]\nx = 1\n");
        await assert.rejects(loadConfig(file, [limitsSection]), (error: unknown) => {
            assert.ok(error instanceof ConfigError);
            assert.equal(error.key, "stray");
            assert.ok(error.message.includes(file));
            assert.ok(error.message.includes("stray"));
            return true;
        });
    });

    it("throws ConfigError with the dotted key and reason when a section rejects its table", async () => {
        await writeFile(file, '[limits]\nmax = "many"\n');
        await assert.rejects(loadConfig(file, [limitsSection]), (error: unknown) => {
            assert.ok(error instanceof ConfigError);
            assert.equal(error.key, "limits.max");
            assert.equal(error.reason, "must be a number");
            assert.ok(error.message.includes(file));
            assert.ok(error.message.includes("limits.max"));
            return true;
        });
    });

    it("throws ConfigError naming an unknown key inside a section table", async () => {
        await writeFile(file, "[limits]\nmin = 1\n");
        await assert.rejects(loadConfig(file, [limitsSection]), (error: unknown) => {
            assert.ok(error instanceof ConfigError);
            assert.equal(error.key, "limits.min");
            return true;
        });
    });
});
