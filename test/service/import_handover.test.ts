import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { acquireOwnership, type OwnershipHandle, readOwnerLock } from "../../src/daemon/ownership.ts";
import { runBob } from "../support/bob_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const TOKEN_VARIABLE = "BOB_OWNER_LOCK_TOKEN";

const envs: HermeticEnv[] = [];
const handles: OwnershipHandle[] = [];

afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.release();
    for (const env of envs.splice(0)) await env.dispose();
});

type Held = { env: HermeticEnv; file: string; token: string };

/** A state directory whose owner lock this test process holds, and an exported database file to import. */
async function heldInstance(): Promise<Held> {
    const env = await createHermeticEnv();
    envs.push(env);
    const file = join(env.root, "backup.db");
    new DatabaseSync(file).close();
    const handle = await acquireOwnership(env.stateDir);
    handles.push(handle);
    const lock = await readOwnerLock(env.stateDir);
    assert.ok(lock, "the test process holds the owner lock");
    return { env, file, token: lock.token };
}

function importWith(held: Held, variables: NodeJS.ProcessEnv) {
    const { env, file } = held;
    return runBob(["import", file, "--config-dir", env.configDir, "--state-dir", env.stateDir], {
        env: { ...env.env, ...variables },
        runtimeDir: env.runtimeDir,
    });
}

async function databasePlaced(env: HermeticEnv): Promise<boolean> {
    return stat(join(env.stateDir, "the-intern.sqlite")).then(
        () => true,
        () => false,
    );
}

describe("bob import under a handed-over owner lock", () => {
    it("places the database when the token is the live lock's", async () => {
        const held = await heldInstance();

        const result = await importWith(held, { [TOKEN_VARIABLE]: held.token });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(await databasePlaced(held.env), true);
    });

    it("leaves the owner lock with the same pid and token when the import ends", async () => {
        const held = await heldInstance();

        const result = await importWith(held, { [TOKEN_VARIABLE]: held.token });

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await readOwnerLock(held.env.stateDir), { pid: process.pid, token: held.token });
    });

    it("refuses with exit 1 when the token is not the live lock's", async () => {
        const held = await heldInstance();

        const result = await importWith(held, { [TOKEN_VARIABLE]: "not-the-token" });

        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(`a running daemon \\(pid ${process.pid}\\)`));
        assert.equal(await databasePlaced(held.env), false);
        assert.deepEqual(await readOwnerLock(held.env.stateDir), { pid: process.pid, token: held.token });
    });

    it("refuses with exit 1 as before when there is no token", async () => {
        const held = await heldInstance();

        const result = await importWith(held, {});

        assert.equal(result.status, 1);
        assert.match(result.stderr, /a running daemon/);
        assert.equal(await databasePlaced(held.env), false);
    });
});
