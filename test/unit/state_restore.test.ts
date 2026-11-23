import assert from "node:assert/strict";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireOwnership, type OwnershipHandle, readOwnerLock } from "../../src/daemon/ownership.ts";
import { type InstanceDirs, resolveInstanceDirs } from "../../src/daemon/state_layout.ts";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import { programLayout } from "../../src/install/program_layout.ts";
import {
    INTERNAL_PARTS,
    importCopy,
    restoreConfig,
    restoreInternal,
    takeCopy,
    upgradesDir,
} from "../../src/install/state_copy.ts";
import { createJobStore, migrateJobStore } from "../../src/jobs/job_store.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const SECRET_TEXT = "sk-never-copied-secret";
const COPIED_AT = new Date("2026-11-22T10:30:00.000Z");
const CHECKOUT_BOB = resolve(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");

const envs: HermeticEnv[] = [];
const handles: OwnershipHandle[] = [];

afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.release();
    for (const env of envs.splice(0)) await env.dispose();
});

type Instance = { env: HermeticEnv; dirs: InstanceDirs };

async function newInstance(options: { config?: boolean; database?: boolean } = {}): Promise<Instance> {
    const env = await createHermeticEnv();
    envs.push(env);
    const dirs = resolveInstanceDirs({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: {},
        homeDir: env.root,
    });
    if (options.database ?? true) {
        const db = await openHostDatabase(dirs.databaseFile);
        await migrateJobStore(db);
        await createJobStore(db).insertJob({
            letter: "A",
            requestText: "request A",
            origin: { kind: "request", wayIn: "command line" },
            leadStart: { role: "lead" },
        });
        await db.close();
    }
    if (options.config ?? true) await writeFile(dirs.configFile, 'name = "bob"\n');
    await mkdir(join(dirs.dataDir, "instructions"), { recursive: true });
    await writeFile(join(dirs.dataDir, "instructions", "common.md"), "common text\n");
    await mkdir(join(dirs.dataDir, "skills", "about"), { recursive: true });
    await writeFile(join(dirs.dataDir, "skills", "about", "SKILL.md"), "skill text\n");
    await writeFile(join(dirs.dataDir, "shipped-files.json"), '{"version":1,"files":{}}');
    await mkdir(dirs.secretsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(dirs.secretsDir, "secrets.json"), SECRET_TEXT);
    return { env, dirs };
}

/** Changes what the copy holds, as a newer version's run would. */
async function driftInternal(dirs: InstanceDirs): Promise<void> {
    await writeFile(join(dirs.dataDir, "instructions", "common.md"), "newer text\n");
    await writeFile(join(dirs.dataDir, "instructions", "extra.md"), "extra\n");
    await rm(join(dirs.dataDir, "skills", "about"), { recursive: true });
    await mkdir(join(dirs.dataDir, "skills", "newer"));
    await writeFile(join(dirs.dataDir, "shipped-files.json"), '{"version":1,"files":{"x":"y"}}');
}

async function treeText(root: string): Promise<Record<string, string>> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const result: Record<string, string> = {};
    for (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        result[path.slice(root.length)] = entry.isDirectory() ? "<dir>" : await readFile(path, "utf8");
    }
    return result;
}

async function restoreEveryPart(dirs: InstanceDirs, copy: string): Promise<void> {
    for (const part of INTERNAL_PARTS) await restoreInternal(dirs, copy, part);
}

async function assertInternalMatchesCopy(dirs: InstanceDirs, copy: string): Promise<void> {
    const copied = join(upgradesDir(dirs.stateDir), copy, "internal");
    for (const part of INTERNAL_PARTS) {
        const expected = await treeText(join(copied, part)).catch(() => readFile(join(copied, part), "utf8"));
        const actual = await treeText(join(dirs.dataDir, part)).catch(() => readFile(join(dirs.dataDir, part), "utf8"));
        assert.deepEqual(actual, expected, part);
    }
    assert.deepEqual((await readdir(dirs.dataDir)).sort(), [...INTERNAL_PARTS].sort());
}

const secretsText = (dirs: InstanceDirs): Promise<string> => readFile(join(dirs.secretsDir, "secrets.json"), "utf8");

describe("restoreConfig", () => {
    it("writes_the_copys_config_file_byte_for_byte_over_the_current_one", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await writeFile(dirs.configFile, 'name = "changed"\n');

        await restoreConfig(dirs, copy, "unused-aside");

        assert.equal(await readFile(dirs.configFile, "utf8"), 'name = "bob"\n');
        assert.deepEqual(await readdir(dirs.configDir), ["config.toml"]);
    });

    it("moves_the_current_file_into_the_aside_folder_when_the_copy_holds_none", async () => {
        const { dirs } = await newInstance({ config: false });
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await writeFile(dirs.configFile, 'name = "newer"\n');

        await restoreConfig(dirs, copy, "2026-11-22T11-00-00-000Z-0.1.0-config");

        await assert.rejects(stat(dirs.configFile), { code: "ENOENT" });
        const aside = join(upgradesDir(dirs.stateDir), "2026-11-22T11-00-00-000Z-0.1.0-config", "config.toml");
        assert.equal(await readFile(aside, "utf8"), 'name = "newer"\n');
    });

    it("moves_the_file_into_an_existing_set_aside_folder_beside_the_database", async () => {
        const { dirs } = await newInstance({ config: false });
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        const aside = join(upgradesDir(dirs.stateDir), "set-aside");
        await mkdir(aside, { recursive: true });
        await writeFile(join(aside, "the-intern.sqlite"), "db");
        await writeFile(dirs.configFile, 'name = "newer"\n');

        await restoreConfig(dirs, copy, "set-aside");

        assert.deepEqual((await readdir(aside)).sort(), ["config.toml", "the-intern.sqlite"]);
    });

    it("completes_with_the_same_result_when_run_again_after_the_file_was_moved", async () => {
        const { dirs } = await newInstance({ config: false });
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await writeFile(dirs.configFile, 'name = "newer"\n');
        await restoreConfig(dirs, copy, "aside");

        await restoreConfig(dirs, copy, "aside");

        await assert.rejects(stat(dirs.configFile), { code: "ENOENT" });
        const aside = join(upgradesDir(dirs.stateDir), "aside", "config.toml");
        assert.equal(await readFile(aside, "utf8"), 'name = "newer"\n');
    });

    it("completes_when_a_cut_off_left_the_copy_beside_the_file_and_leaves_none_after", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await writeFile(dirs.configFile, 'name = "changed"\n');
        await writeFile(join(dirs.configDir, ".config.toml.restore"), "half");

        await restoreConfig(dirs, copy, "aside");

        assert.equal(await readFile(dirs.configFile, "utf8"), 'name = "bob"\n');
        assert.deepEqual(await readdir(dirs.configDir), ["config.toml"]);
    });

    it("leaves_the_secrets_store_as_it_was", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);

        await restoreConfig(dirs, copy, "aside");

        assert.equal(await secretsText(dirs), SECRET_TEXT);
    });
});

describe("restoreInternal", () => {
    it("makes_instructions_skills_and_the_shipped_record_match_the_copy_with_nothing_left_over", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await driftInternal(dirs);

        await restoreEveryPart(dirs, copy);

        await assertInternalMatchesCopy(dirs, copy);
    });

    it("removes_a_part_the_copy_does_not_hold", async () => {
        const { dirs } = await newInstance();
        await rm(join(dirs.dataDir, "shipped-files.json"));
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await writeFile(join(dirs.dataDir, "shipped-files.json"), "newer");

        await restoreInternal(dirs, copy, "shipped-files.json");

        await assert.rejects(stat(join(dirs.dataDir, "shipped-files.json")), { code: "ENOENT" });
    });

    it("gives_the_same_result_when_every_part_is_run_again", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await driftInternal(dirs);
        await restoreEveryPart(dirs, copy);

        await restoreEveryPart(dirs, copy);

        await assertInternalMatchesCopy(dirs, copy);
    });

    it("completes_after_a_cut_off_in_the_middle_of_the_copy_into_staging", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await driftInternal(dirs);
        await mkdir(join(dirs.dataDir, ".restore-instructions"));
        await writeFile(join(dirs.dataDir, ".restore-instructions", "half.md"), "half");

        await restoreEveryPart(dirs, copy);

        await assertInternalMatchesCopy(dirs, copy);
    });

    it("completes_after_a_cut_off_between_renaming_the_current_folder_aside_and_the_copy_in", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await driftInternal(dirs);
        const copied = join(upgradesDir(dirs.stateDir), copy, "internal", "skills");
        await cp(copied, join(dirs.dataDir, ".restore-skills"), { recursive: true });
        await rename(join(dirs.dataDir, "skills"), join(dirs.dataDir, ".aside-skills"));

        await restoreEveryPart(dirs, copy);

        await assertInternalMatchesCopy(dirs, copy);
    });

    it("completes_after_a_cut_off_before_the_aside_folder_was_removed", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);
        await driftInternal(dirs);
        await restoreEveryPart(dirs, copy);
        await mkdir(join(dirs.dataDir, ".aside-instructions"));

        await restoreEveryPart(dirs, copy);

        await assertInternalMatchesCopy(dirs, copy);
    });

    it("leaves_the_secrets_store_as_it_was", async () => {
        const { dirs } = await newInstance();
        const copy = await takeCopy(dirs, "0.0.9", "0.1.0", COPIED_AT);

        await restoreEveryPart(dirs, copy);

        assert.equal(await secretsText(dirs), SECRET_TEXT);
    });
});

describe("importCopy", () => {
    async function versionWithBob(home: string): Promise<ReturnType<typeof programLayout>> {
        const layout = programLayout(home);
        const bin = join(layout.versionDir("0.0.9"), "bin");
        await mkdir(bin, { recursive: true });
        const script = join(bin, "bob");
        await writeFile(script, `#!/bin/sh\nexec node "${CHECKOUT_BOB}" "$@"\n`);
        await chmod(script, 0o755);
        return layout;
    }

    async function heldTarget(): Promise<{ target: Instance; token: string }> {
        const target = await newInstance({ database: false, config: false });
        const handle = await acquireOwnership(target.dirs.stateDir);
        handles.push(handle);
        const lock = await readOwnerLock(target.dirs.stateDir);
        assert.ok(lock, "the test process holds the owner lock");
        return { target, token: lock.token };
    }

    it("places_the_copys_database_in_the_state_directory_and_leaves_the_owner_lock_held", async () => {
        const source = await newInstance();
        const copy = await takeCopy(source.dirs, "0.0.9", "0.1.0", COPIED_AT);
        const { target, token } = await heldTarget();
        const layout = await versionWithBob(target.env.root);
        await cp(join(upgradesDir(source.dirs.stateDir), copy), join(upgradesDir(target.dirs.stateDir), copy), {
            recursive: true,
        });

        await importCopy(layout, "0.0.9", target.dirs, copy, token);

        const db = await openHostDatabase(target.dirs.databaseFile, { readOnly: true });
        const rows = await db.all<{ letter: string }>("SELECT letter FROM intern_jobs");
        await db.close();
        assert.deepEqual(
            rows.map((row) => row.letter),
            ["A"],
        );
        assert.deepEqual(await readOwnerLock(target.dirs.stateDir), { pid: process.pid, token });
        assert.equal(await secretsText(target.dirs), SECRET_TEXT);
    });

    it("fails_with_the_standard_error_of_the_child_when_it_exits_non_zero", async () => {
        const source = await newInstance();
        const copy = await takeCopy(source.dirs, "0.0.9", "0.1.0", COPIED_AT);
        const { target } = await heldTarget();
        const layout = await versionWithBob(target.env.root);
        await cp(join(upgradesDir(source.dirs.stateDir), copy), join(upgradesDir(target.dirs.stateDir), copy), {
            recursive: true,
        });

        await assert.rejects(importCopy(layout, "0.0.9", target.dirs, copy, "not-the-token"), (error: Error) =>
            /a running daemon/.test(error.message),
        );
    });
});
