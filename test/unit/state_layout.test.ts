import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ensureInstanceDirs, InstanceDirError, resolveInstanceDirs } from "../../src/daemon/state_layout.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const HOME = "/home/team";

describe("resolveInstanceDirs", () => {
    it("resolves the four directories under the XDG base directories", () => {
        const dirs = resolveInstanceDirs({
            flags: {},
            env: {
                XDG_CONFIG_HOME: "/xdg/config",
                XDG_STATE_HOME: "/xdg/state",
                XDG_DATA_HOME: "/xdg/data",
                XDG_RUNTIME_DIR: "/xdg/run",
            },
            homeDir: HOME,
        });
        assert.equal(dirs.configDir, "/xdg/config/the-intern");
        assert.equal(dirs.stateDir, "/xdg/state/the-intern");
        assert.equal(dirs.dataDir, "/xdg/data/the-intern");
        assert.equal(dirs.runtimeDir, "/xdg/run/the-intern");
    });

    it("falls back to the home defaults when the variables are unset", () => {
        const dirs = resolveInstanceDirs({ flags: {}, env: {}, homeDir: HOME });
        assert.equal(dirs.configDir, "/home/team/.config/the-intern");
        assert.equal(dirs.stateDir, "/home/team/.local/state/the-intern");
        assert.equal(dirs.dataDir, "/home/team/.local/share/the-intern");
        assert.equal(dirs.runtimeDir, "/home/team/.local/state/the-intern/run");
    });

    it("falls back to the defaults when the variables are empty or relative", () => {
        const dirs = resolveInstanceDirs({
            flags: {},
            env: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "relative/state", XDG_DATA_HOME: ".", XDG_RUNTIME_DIR: "run" },
            homeDir: HOME,
        });
        assert.equal(dirs.configDir, "/home/team/.config/the-intern");
        assert.equal(dirs.stateDir, "/home/team/.local/state/the-intern");
        assert.equal(dirs.dataDir, "/home/team/.local/share/the-intern");
        assert.equal(dirs.runtimeDir, "/home/team/.local/state/the-intern/run");
    });

    it("places the runtime fallback inside a state directory given by flag", () => {
        const dirs = resolveInstanceDirs({ flags: { stateDir: "/srv/state" }, env: {}, homeDir: HOME });
        assert.equal(dirs.runtimeDir, "/srv/state/run");
    });

    it("uses a directory flag as the directory itself without appending the-intern", () => {
        const dirs = resolveInstanceDirs({
            flags: { configDir: "/a", stateDir: "/b", dataDir: "/c", runtimeDir: "/d" },
            env: { XDG_CONFIG_HOME: "/xdg/config" },
            homeDir: HOME,
        });
        assert.deepEqual([dirs.configDir, dirs.stateDir, dirs.dataDir, dirs.runtimeDir], ["/a", "/b", "/c", "/d"]);
    });

    it("derives the config file and database file from the resolved directories", () => {
        const dirs = resolveInstanceDirs({
            flags: { configDir: "/a", stateDir: "/b" },
            env: {},
            homeDir: HOME,
        });
        assert.equal(dirs.configFile, "/a/config.toml");
        assert.equal(dirs.databaseFile, "/b/the-intern.sqlite");
    });

    it("throws InstanceDirError naming the value when a directory flag is relative", () => {
        assert.throws(
            () => resolveInstanceDirs({ flags: { dataDir: "rel/data" }, env: {}, homeDir: HOME }),
            (error: unknown) => {
                assert.ok(error instanceof InstanceDirError);
                assert.equal(error.path, "rel/data");
                assert.match(error.message, /rel\/data/);
                assert.match(error.message, /absolute/);
                return true;
            },
        );
    });
});

describe("ensureInstanceDirs", () => {
    let hermetic: HermeticEnv;

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
    });

    afterEach(async () => {
        await hermetic.dispose();
    });

    function layout(base: string) {
        return resolveInstanceDirs({
            flags: {
                configDir: join(base, "config"),
                stateDir: join(base, "state"),
                dataDir: join(base, "data"),
                runtimeDir: join(base, "state", "run"),
            },
            env: {},
            homeDir: HOME,
        });
    }

    it("creates missing directories with mode 0700 and missing parents", async () => {
        const dirs = layout(join(hermetic.root, "fresh", "nested"));
        const previousUmask = process.umask(0o077);
        process.umask(0o000);
        try {
            await ensureInstanceDirs(dirs);
        } finally {
            process.umask(previousUmask);
        }
        for (const dir of [dirs.configDir, dirs.stateDir, dirs.dataDir, dirs.runtimeDir]) {
            const info = await stat(dir);
            assert.ok(info.isDirectory());
            assert.equal(info.mode & 0o777, 0o700, dir);
        }
    });

    it("accepts existing owner-only directories", async () => {
        const dirs = layout(join(hermetic.root, "instance"));
        await ensureInstanceDirs(dirs);
        await ensureInstanceDirs(dirs);
    });

    it("refuses an existing path that is not a directory and names the path", async () => {
        const dirs = layout(join(hermetic.root, "instance"));
        await mkdir(dirname(dirs.dataDir), { recursive: true });
        await writeFile(dirs.dataDir, "x");
        await assert.rejects(ensureInstanceDirs(dirs), (error: unknown) => {
            assert.ok(error instanceof InstanceDirError);
            assert.equal(error.path, dirs.dataDir);
            assert.match(error.message, new RegExp(dirs.dataDir));
            assert.match(error.message, /not a directory/);
            return true;
        });
    });

    it("refuses an existing directory accessible to the group or others", async () => {
        const dirs = layout(join(hermetic.root, "instance"));
        await mkdir(dirs.stateDir, { recursive: true });
        await chmod(dirs.stateDir, 0o750);
        await assert.rejects(ensureInstanceDirs(dirs), (error: unknown) => {
            assert.ok(error instanceof InstanceDirError);
            assert.equal(error.path, dirs.stateDir);
            assert.match(error.message, /group or others/);
            return true;
        });
    });

    it("refuses a directory not owned by the service account", async (t) => {
        const dirs = layout(join(hermetic.root, "instance"));
        await mkdir(dirs.configDir, { recursive: true, mode: 0o700 });
        const realUid = process.getuid;
        t.mock.method(process, "getuid", () => (realUid?.() ?? 0) + 1, { getter: false });
        await assert.rejects(ensureInstanceDirs(dirs), (error: unknown) => {
            assert.ok(error instanceof InstanceDirError);
            assert.equal(error.path, dirs.configDir);
            assert.match(error.message, /owned/);
            return true;
        });
    });

    it("creates nothing when any existing directory is refused", async () => {
        const dirs = layout(join(hermetic.root, "instance"));
        await mkdir(dirs.dataDir, { recursive: true });
        await chmod(dirs.dataDir, 0o755);
        await assert.rejects(ensureInstanceDirs(dirs), InstanceDirError);
        await assert.rejects(stat(dirs.configDir), { code: "ENOENT" });
        await assert.rejects(stat(dirs.stateDir), { code: "ENOENT" });
        assert.equal((await stat(dirs.dataDir)).mode & 0o777, 0o755);
    });
});
