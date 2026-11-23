import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const created: HermeticEnv[] = [];

async function makeEnv(): Promise<HermeticEnv> {
    const hermetic = await createHermeticEnv();
    created.push(hermetic);
    return hermetic;
}

function modeOf(path: string): number {
    return statSync(path).mode & 0o777;
}

afterEach(async () => {
    await Promise.all(created.splice(0).map((hermetic) => hermetic.dispose()));
});

describe("createHermeticEnv", () => {
    it("creates the five directories under the root with owner-only mode", async () => {
        const hermetic = await makeEnv();
        for (const dir of [
            hermetic.configDir,
            hermetic.stateDir,
            hermetic.dataDir,
            hermetic.runtimeDir,
            hermetic.piAgentDir,
        ]) {
            assert.ok(dir.startsWith(`${hermetic.root}/`), `${dir} is under the root`);
            assert.equal(modeOf(dir), OWNER_ONLY_MODE, `${dir} mode`);
        }
    });

    it("points every XDG, pi agent and HOME variable into the root", async () => {
        const hermetic = await makeEnv();
        assert.equal(hermetic.env.XDG_CONFIG_HOME, hermetic.configDir);
        assert.equal(hermetic.env.XDG_STATE_HOME, hermetic.stateDir);
        assert.equal(hermetic.env.XDG_DATA_HOME, hermetic.dataDir);
        assert.equal(hermetic.env.XDG_RUNTIME_DIR, hermetic.runtimeDir);
        assert.equal(hermetic.env.PI_CODING_AGENT_DIR, hermetic.piAgentDir);
        assert.equal(hermetic.env.HOME, hermetic.root);
    });

    it("gives each call its own root", async () => {
        const first = await makeEnv();
        const second = await makeEnv();
        assert.notEqual(first.root, second.root);
    });

    it("drops inherited BOB_ and PI_ variables but keeps the rest", async () => {
        const previous = { ...process.env };
        process.env.BOB_SOCKET = "/run/user/1000/bob.sock";
        process.env.PI_OFFLINE = "1";
        process.env.PATH_KEPT_MARKER = "kept";
        try {
            const hermetic = await makeEnv();
            assert.equal(hermetic.env.BOB_SOCKET, undefined);
            assert.equal(hermetic.env.PI_OFFLINE, undefined);
            assert.equal(hermetic.env.PATH_KEPT_MARKER, "kept");
        } finally {
            for (const key of ["BOB_SOCKET", "PI_OFFLINE", "PATH_KEPT_MARKER"]) {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
            }
        }
    });

    it("removes the root when disposed", async () => {
        const hermetic = await makeEnv();
        await hermetic.dispose();
        assert.equal(existsSync(hermetic.root), false);
    });
});
