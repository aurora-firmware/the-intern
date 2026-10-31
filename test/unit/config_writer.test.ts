import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigValueError, defineConfigSection, loadConfig } from "../../src/config/config_file.ts";
import { ConfigChangeRefused, createConfigStore } from "../../src/config/config_writer.ts";

type Limits = { max: number };

const limitsSection = defineConfigSection<Limits>({
    name: "limits",
    defaults: () => ({ max: 1 }),
    parse(table) {
        for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
            if (key !== "max") throw new ConfigValueError(key, "unknown key");
            if (typeof value !== "number" || value < 0)
                throw new ConfigValueError(key, "must be a non-negative number");
        }
        return { max: (table as Limits).max ?? 1 };
    },
    serialize: (value) => ({ max: value.max }),
});

const labelSection = defineConfigSection<{ label: string }>({
    name: "label",
    defaults: () => ({ label: "none" }),
    parse: (table) => ({ label: (table as { label?: string }).label ?? "none" }),
    serialize: (value) => ({ label: value.label }),
});

const sections = [limitsSection, labelSection];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("createConfigStore", () => {
    let directory: string;
    let file: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "config-writer-"));
        file = join(directory, "config.toml");
    });

    afterEach(async () => {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
    });

    async function openStore() {
        return createConfigStore(file, sections, await loadConfig(file, sections));
    }

    it("writes an owner-only file, returns the new value and notifies each listener once", async () => {
        const store = await openStore();
        const first: string[] = [];
        const second: string[] = [];
        store.onChange((change) => first.push(change.section));
        store.onChange((change) => second.push(change.section));

        await store.change(limitsSection, { max: 5 });

        assert.deepEqual(store.current(limitsSection), { max: 5 });
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.deepEqual(first, ["limits"]);
        assert.deepEqual(second, ["limits"]);
    });

    it("writes only the sections that differ from their defaults and leaves no temporary file", async () => {
        const store = await openStore();
        await store.change(limitsSection, { max: 5 });
        await store.change(labelSection, { label: "none" });
        assert.equal(await readFile(file, "utf8"), "[limits]\nmax = 5\n");
        assert.deepEqual(await readdir(directory), ["config.toml"]);
    });

    it("stops notifying a listener after it unsubscribes", async () => {
        const store = await openStore();
        const seen: string[] = [];
        const unsubscribe = store.onChange((change) => seen.push(change.section));
        unsubscribe();
        await store.change(limitsSection, { max: 2 });
        assert.deepEqual(seen, []);
    });

    it("refuses an invalid value naming the setting and leaves the file and value unchanged", async () => {
        const store = await openStore();
        await store.change(limitsSection, { max: 3 });
        const before = await readFile(file, "utf8");
        const seen: string[] = [];
        store.onChange((change) => seen.push(change.section));

        await assert.rejects(store.change(limitsSection, { max: -1 }), (error) => {
            assert.ok(error instanceof ConfigChangeRefused);
            assert.equal(error.kind, "invalid");
            assert.equal(error.key, "limits.max");
            assert.match(error.reason, /non-negative/);
            return true;
        });

        assert.equal(await readFile(file, "utf8"), before);
        assert.deepEqual(store.current(limitsSection), { max: 3 });
        assert.deepEqual(seen, []);
    });

    it("refuses with conflict naming the file when the file was edited by hand", async () => {
        const store = await openStore();
        await store.change(limitsSection, { max: 3 });
        await writeFile(file, "[limits]\nmax = 9\n");

        await assert.rejects(store.change(limitsSection, { max: 4 }), (error) => {
            assert.ok(error instanceof ConfigChangeRefused);
            assert.equal(error.kind, "conflict");
            assert.equal(error.file, file);
            assert.match(error.message, new RegExp(file));
            return true;
        });

        assert.equal(await readFile(file, "utf8"), "[limits]\nmax = 9\n");
        assert.deepEqual(store.current(limitsSection), { max: 3 });
    });

    it("refuses with conflict when the file appeared after the store loaded a missing file", async () => {
        const store = await openStore();
        await writeFile(file, "[limits]\nmax = 9\n");
        await assert.rejects(
            store.change(limitsSection, { max: 4 }),
            (error) => error instanceof ConfigChangeRefused && error.kind === "conflict",
        );
    });

    it("refuses with conflict when the file was removed after the store read it", async () => {
        await writeFile(file, "[limits]\nmax = 2\n");
        const store = await openStore();
        await rm(file);
        await assert.rejects(
            store.change(limitsSection, { max: 4 }),
            (error) => error instanceof ConfigChangeRefused && error.kind === "conflict",
        );
    });

    it("accepts a second change after the first because the fingerprint tracks the written bytes", async () => {
        const store = await openStore();
        await store.change(limitsSection, { max: 3 });
        await store.change(limitsSection, { max: 4 });
        assert.equal(sha256(await readFile(file, "utf8")), sha256("[limits]\nmax = 4\n"));
    });

    it("refuses with write_failed and leaves the value unchanged when the file can't be written", async () => {
        const missingDirectory = join(directory, "missing");
        const missingFile = join(missingDirectory, "config.toml");
        const store = createConfigStore(missingFile, sections, await loadConfig(missingFile, sections));
        const seen: string[] = [];
        store.onChange((change) => seen.push(change.section));

        await assert.rejects(store.change(limitsSection, { max: 5 }), (error) => {
            assert.ok(error instanceof ConfigChangeRefused);
            assert.equal(error.kind, "write_failed");
            assert.equal(error.file, missingFile);
            assert.match(error.reason, /ENOENT/);
            return true;
        });

        assert.deepEqual(store.current(limitsSection), { max: 1 });
        assert.deepEqual(seen, []);
    });

    it("applies concurrent changes one at a time in call order", async () => {
        const store = await openStore();
        await Promise.all([store.change(limitsSection, { max: 2 }), store.change(limitsSection, { max: 7 })]);
        assert.deepEqual(store.current(limitsSection), { max: 7 });
        assert.equal(await readFile(file, "utf8"), "[limits]\nmax = 7\n");
    });

    it("keeps serving changes after a refused one", async () => {
        const store = await openStore();
        await assert.rejects(store.change(limitsSection, { max: -1 }));
        await store.change(limitsSection, { max: 2 });
        assert.deepEqual(store.current(limitsSection), { max: 2 });
    });

    it("lets loadConfig return the changed value as after a restart", async () => {
        const store = await openStore();
        await store.change(limitsSection, { max: 5 });
        await store.change(labelSection, { label: "x" });

        const reloaded = await loadConfig(file, sections);

        assert.deepEqual(reloaded.values.get("limits"), { max: 5 });
        assert.deepEqual(reloaded.values.get("label"), { label: "x" });
    });
});
