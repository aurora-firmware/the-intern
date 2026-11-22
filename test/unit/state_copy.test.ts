import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type InstanceDirs, resolveInstanceDirs } from "../../src/daemon/state_layout.ts";
import { importDatabase } from "../../src/host/database_import.ts";
import { openHostDatabase } from "../../src/host/harness_host.ts";
import { createJobStore, migrateJobStore } from "../../src/jobs/job_store.ts";
import {
    type CopyInfo,
    copyFor,
    latestCopy,
    markKept,
    pruneCopies,
    readCopyInfo,
    setAside,
    takeCopy,
    upgradesDir,
} from "../../src/install/state_copy.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const SECRET_TEXT = "sk-never-copied-secret";

const envs: HermeticEnv[] = [];

afterEach(async () => {
    for (const env of envs.splice(0)) await env.dispose();
});

type Instance = { env: HermeticEnv; dirs: InstanceDirs; jobNumbers: string[] };

async function newInstance(options: { config?: boolean } = {}): Promise<Instance> {
    const env = await createHermeticEnv();
    envs.push(env);
    const dirs = resolveInstanceDirs({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: {},
        homeDir: env.root,
    });
    const db = await openHostDatabase(dirs.databaseFile);
    await migrateJobStore(db);
    const store = createJobStore(db);
    const jobNumbers: string[] = [];
    for (const letter of ["A", "B"] as const) {
        const { job } = await store.insertJob({
            letter,
            requestText: `request ${letter}`,
            origin: { kind: "request", wayIn: "command line" },
            leadStart: { role: "lead" },
        });
        jobNumbers.push(job.number);
    }
    await db.close();
    if (options.config ?? true) await writeFile(dirs.configFile, 'name = "bob"\n');
    await mkdir(join(dirs.dataDir, "instructions"));
    await writeFile(join(dirs.dataDir, "instructions", "common.md"), "common text\n");
    await mkdir(join(dirs.dataDir, "skills", "about"), { recursive: true });
    await writeFile(join(dirs.dataDir, "skills", "about", "SKILL.md"), "skill text\n");
    await writeFile(join(dirs.dataDir, "shipped-files.json"), '{"version":1,"files":{}}');
    await mkdir(dirs.secretsDir, { mode: OWNER_ONLY_DIR });
    await writeFile(join(dirs.secretsDir, "secrets.json"), SECRET_TEXT);
    return { env, dirs, jobNumbers };
}

async function filesUnder(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.map((entry) => join(entry.parentPath, entry.name));
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const at = (iso: string): Date => new Date(iso);

describe("takeCopy", () => {
    it("holds_copy_json_the_database_the_config_and_the_internal_folder_of_the_instance", async () => {
        const { dirs } = await newInstance();
        const now = at("2026-11-22T10:30:00.000Z");

        const name = await takeCopy(dirs, "0.0.9", "0.1.0", now);

        const folder = join(upgradesDir(dirs.stateDir), name);
        assert.match(name, /^2026-11-22T10-30-00-000Z-0\.0\.9-to-0\.1\.0$/);
        assert.deepEqual(await readdir(folder), ["config.toml", "copy.json", "database.sqlite", "internal"]);
        const info = JSON.parse(await readFile(join(folder, "copy.json"), "utf8")) as CopyInfo;
        assert.deepEqual(info, {
            format: 1,
            from: "0.0.9",
            to: "0.1.0",
            time: "2026-11-22T10:30:00.000Z",
            parts: ["database.sqlite", "config.toml", "internal"],
            kept: false,
        });
        assert.equal(await readFile(join(folder, "config.toml"), "utf8"), 'name = "bob"\n');
        for (const part of ["instructions/common.md", "skills/about/SKILL.md", "shipped-files.json"]) {
            const copied = await readFile(join(folder, "internal", part));
            assert.ok(copied.equals(await readFile(join(dirs.dataDir, part))), part);
        }
    });

    it("makes_a_database_that_bob_import_accepts_with_every_job", async () => {
        const { dirs, jobNumbers } = await newInstance();
        const name = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:30:00.000Z"));
        const target = await createHermeticEnv();
        envs.push(target);

        await importDatabase({ stateDir: target.stateDir, file: join(upgradesDir(dirs.stateDir), name, "database.sqlite") });

        const imported = await openHostDatabase(join(target.stateDir, "the-intern.sqlite"), { readOnly: true });
        const rows = await imported.all<{ letter: string; n: number }>("SELECT letter, n FROM intern_jobs ORDER BY letter");
        await imported.close();
        assert.deepEqual(
            rows.map((row) => `${row.letter}-${row.n}`),
            jobNumbers,
        );
    });

    it("copies_nothing_from_the_secrets_store", async () => {
        const { dirs } = await newInstance();
        const name = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:30:00.000Z"));

        for (const path of await filesUnder(join(upgradesDir(dirs.stateDir), name))) {
            assert.doesNotMatch(path, /secrets/);
            if ((await stat(path)).isFile()) assert.ok(!(await readFile(path)).includes(SECRET_TEXT), path);
        }
    });

    it("leaves_out_the_config_part_when_the_instance_has_no_config_file", async () => {
        const { dirs } = await newInstance({ config: false });
        const name = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:30:00.000Z"));

        const folder = join(upgradesDir(dirs.stateDir), name);
        assert.deepEqual(await readdir(folder), ["copy.json", "database.sqlite", "internal"]);
        assert.deepEqual((await readCopyInfo(dirs, name)).parts, ["database.sqlite", "internal"]);
    });

    it("leaves_only_a_partial_folder_when_it_is_cut_off_before_its_rename", async () => {
        const { dirs } = await newInstance();
        await rm(dirs.configFile);
        await mkdir(dirs.configFile);

        await assert.rejects(takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:30:00.000Z")));

        const entries = await readdir(upgradesDir(dirs.stateDir));
        assert.equal(entries.length, 1);
        assert.match(entries[0] ?? "", /^\.partial-/);
        assert.equal(await latestCopy(dirs), undefined);
    });

    it("refuses_without_creating_a_database_when_the_instance_has_none", async () => {
        const { dirs } = await newInstance();
        await rm(dirs.databaseFile);

        await assert.rejects(takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:30:00.000Z")), /database/);

        assert.equal((await readdir(dirs.stateDir)).includes("the-intern.sqlite"), false);
    });

    it("makes_the_upgrades_folder_the_copy_and_every_file_in_it_owner_only", async () => {
        const { dirs } = await newInstance();
        await chmod(join(dirs.dataDir, "instructions", "common.md"), 0o644);
        const name = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:30:00.000Z"));

        assert.equal(await modeOf(upgradesDir(dirs.stateDir)), OWNER_ONLY_DIR);
        const folder = join(upgradesDir(dirs.stateDir), name);
        assert.equal(await modeOf(folder), OWNER_ONLY_DIR);
        for (const path of await filesUnder(folder)) {
            const expected = (await stat(path)).isDirectory() ? OWNER_ONLY_DIR : OWNER_ONLY_FILE;
            assert.equal(await modeOf(path), expected, path);
        }
    });
});

describe("setAside", () => {
    it("moves_the_database_with_its_wal_and_shm_files_into_a_folder_named_for_time_version_and_reason", async () => {
        const { dirs } = await newInstance();
        await writeFile(`${dirs.databaseFile}-wal`, "wal bytes");
        await writeFile(`${dirs.databaseFile}-shm`, "shm bytes");
        const before = await readFile(dirs.databaseFile);

        const name = await setAside(dirs, "0.1.0", "failed-upgrade", at("2026-11-22T11:00:00.000Z"));

        assert.equal(name, "2026-11-22T11-00-00-000Z-0.1.0-failed-upgrade");
        const folder = join(upgradesDir(dirs.stateDir), name);
        assert.deepEqual(await readdir(folder), ["the-intern.sqlite", "the-intern.sqlite-shm", "the-intern.sqlite-wal"]);
        assert.ok((await readFile(join(folder, "the-intern.sqlite"))).equals(before));
        assert.equal(await readFile(join(folder, "the-intern.sqlite-wal"), "utf8"), "wal bytes");
        assert.equal((await readdir(dirs.stateDir)).filter((entry) => entry.startsWith("the-intern.sqlite")).length, 0);
    });

    it("makes_the_folder_and_every_file_moved_into_it_owner_only", async () => {
        const { dirs } = await newInstance();
        await writeFile(`${dirs.databaseFile}-wal`, "wal bytes");
        await chmod(`${dirs.databaseFile}-wal`, 0o644);

        const name = await setAside(dirs, "0.1.0", "unreadable", at("2026-11-22T11:00:00.000Z"));

        const folder = join(upgradesDir(dirs.stateDir), name);
        assert.equal(await modeOf(upgradesDir(dirs.stateDir)), OWNER_ONLY_DIR);
        assert.equal(await modeOf(folder), OWNER_ONLY_DIR);
        for (const path of await filesUnder(folder)) assert.equal(await modeOf(path), OWNER_ONLY_FILE, path);
    });
});

describe("the copies a rollback and a prune look at", () => {
    it("returns_the_copy_for_the_versions_even_when_a_newer_copy_exists", async () => {
        const { dirs } = await newInstance();
        const first = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:00:00.000Z"));
        await takeCopy(dirs, "0.1.0", "0.2.0", at("2026-11-22T11:00:00.000Z"));

        assert.equal(await copyFor(dirs, "0.0.9", "0.1.0"), first);
        assert.equal(await copyFor(dirs, "0.0.9", "0.3.0"), undefined);
    });

    it("returns_the_newest_copy_of_the_versions_when_there_are_two", async () => {
        const { dirs } = await newInstance();
        await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:00:00.000Z"));
        const second = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T12:00:00.000Z"));

        assert.equal(await copyFor(dirs, "0.0.9", "0.1.0"), second);
    });

    it("returns_the_newest_copy_and_its_info_and_ignores_set_aside_folders", async () => {
        const { dirs } = await newInstance();
        await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:00:00.000Z"));
        const second = await takeCopy(dirs, "0.1.0", "0.2.0", at("2026-11-22T11:00:00.000Z"));
        await setAside(dirs, "0.2.0", "rollback", at("2026-11-22T12:00:00.000Z"));

        const latest = await latestCopy(dirs);

        assert.equal(latest?.name, second);
        assert.equal(latest?.info.from, "0.1.0");
        assert.equal(latest?.info.to, "0.2.0");
    });

    it("returns_undefined_when_there_is_no_upgrades_folder", async () => {
        const { dirs } = await newInstance();

        assert.equal(await latestCopy(dirs), undefined);
        assert.equal(await copyFor(dirs, "0.0.9", "0.1.0"), undefined);
    });

    it("marks_a_copy_kept_and_leaves_the_rest_of_its_info", async () => {
        const { dirs } = await newInstance();
        const name = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:00:00.000Z"));

        await markKept(dirs, name);

        const info = await readCopyInfo(dirs, name);
        assert.equal(info.kept, true);
        assert.equal(info.from, "0.0.9");
        assert.equal(await modeOf(join(upgradesDir(dirs.stateDir), name, "copy.json")), OWNER_ONLY_FILE);
    });

    it("refuses_a_copy_json_of_a_newer_format_naming_the_file", async () => {
        const { dirs } = await newInstance();
        const name = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:00:00.000Z"));
        const file = join(upgradesDir(dirs.stateDir), name, "copy.json");
        await writeFile(file, JSON.stringify({ format: 2 }));

        await assert.rejects(readCopyInfo(dirs, name), (error: Error) => error.message.includes(file));
    });
});

describe("pruneCopies", () => {
    it("removes_only_older_copies_that_are_not_kept_and_no_set_aside_database", async () => {
        const { dirs } = await newInstance();
        const kept = await takeCopy(dirs, "0.0.7", "0.0.8", at("2026-11-22T08:00:00.000Z"));
        await markKept(dirs, kept);
        const old = await takeCopy(dirs, "0.0.8", "0.0.9", at("2026-11-22T09:00:00.000Z"));
        const aside = await setAside(dirs, "0.0.9", "failed-upgrade", at("2026-11-22T09:30:00.000Z"));
        const current = await takeCopy(dirs, "0.0.9", "0.1.0", at("2026-11-22T10:00:00.000Z"));
        const newer = await takeCopy(dirs, "0.1.0", "0.2.0", at("2026-11-22T11:00:00.000Z"));

        await pruneCopies(dirs, current);

        const remaining = await readdir(upgradesDir(dirs.stateDir));
        assert.deepEqual(remaining.sort(), [kept, aside, current, newer].sort());
        assert.equal(remaining.includes(old), false);
    });
});
