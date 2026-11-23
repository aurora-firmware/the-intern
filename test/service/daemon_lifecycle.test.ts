import assert from "node:assert/strict";
import { access, chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type DaemonComponent, type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { type DaemonProcess, type StartDaemonOptions, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const DATABASE_FILE_NAME = "the-intern.sqlite";
const CONFIG_FILE_NAME = "config.toml";
const GROUP_READABLE_MODE = 0o750;
const PERMISSION_BITS = 0o777;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const inProcessDaemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of inProcessDaemons.splice(0)) await daemon.stop();
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

function start(options: StartDaemonOptions): DaemonProcess {
    const daemon = startDaemon(options);
    daemons.push(daemon);
    return daemon;
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

async function modeOf(path: string): Promise<number> {
    return (await stat(path)).mode & PERMISSION_BITS;
}

describe("single ownership", () => {
    it("refuses a second daemon on the same state directory and names the first daemon's pid", async () => {
        const env = await hermetic();
        const first = start({ hermetic: env });
        await first.ready;

        const second = start({ hermetic: env });

        assert.notEqual((await second.exited).code, 0);
        assert.match(second.stderr(), new RegExp(env.stateDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(second.stderr(), new RegExp(`pid ${first.pid}\\b`));
        const status = (await first.invoke("daemon.status", {})) as DaemonStatus;
        assert.equal(status.phase, "ready");
    });

    it("takes over the state directory of an owner killed with kill -9", async () => {
        const env = await hermetic();
        const first = start({ hermetic: env });
        await first.ready;
        first.kill9();
        await first.exited;

        const second = start({ hermetic: env });
        await second.ready;

        const status = (await second.invoke("daemon.status", {})) as DaemonStatus;
        assert.equal(status.phase, "ready");
    });

    it("runs two daemons with different state directories side by side", async () => {
        const [envA, envB] = [await hermetic(), await hermetic()];
        const a = start({ hermetic: envA });
        const b = start({ hermetic: envB });

        await Promise.all([a.ready, b.ready]);

        for (const daemon of [a, b]) {
            const status = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
            assert.equal(status.phase, "ready");
        }
        assert.notEqual(a.pid, b.pid);
    });
});

describe("startup failures", () => {
    async function assertFailsAt(daemon: DaemonProcess, stepPattern: RegExp, causePattern: RegExp): Promise<void> {
        await assert.rejects(daemon.ready, /exited/);
        assert.notEqual((await daemon.exited).code, 0);
        assert.match(daemon.stderr(), stepPattern);
        assert.match(daemon.stderr(), causePattern);
    }

    it("exits naming the load configuration step when config.toml can't be parsed", async () => {
        const env = await hermetic();
        await writeFile(join(env.configDir, CONFIG_FILE_NAME), "this is = = not toml [");

        await assertFailsAt(start({ hermetic: env }), /name="load configuration"/, /invalid TOML/);

        assert.equal(await exists(join(env.stateDir, DATABASE_FILE_NAME)), false);
    });

    it("exits naming the load configuration step when config.toml has an unknown top-level key", async () => {
        const env = await hermetic();
        await writeFile(join(env.configDir, CONFIG_FILE_NAME), 'mystery_key = "x"\n');

        await assertFailsAt(
            start({ hermetic: env }),
            /name="load configuration"/,
            /mystery_key: no configuration section owns this key/,
        );

        assert.equal(await exists(join(env.stateDir, DATABASE_FILE_NAME)), false);
    });

    it("exits naming the directory step when the state directory is group-readable", async () => {
        const env = await hermetic();
        await chmod(env.stateDir, GROUP_READABLE_MODE);

        await assertFailsAt(
            start({ hermetic: env }),
            /name="ensure directories"/,
            /the directory is accessible to the group or others/,
        );

        assert.equal(await exists(join(env.stateDir, DATABASE_FILE_NAME)), false);
    });

    it("exits naming the check models step when a configured model doesn't resolve", async () => {
        const env = await hermetic();

        await assertFailsAt(start({ hermetic: env, checkModel: "nowhere/nothing" }), /name="check models"/, /nowhere/);
    });
});

describe("readiness", () => {
    it("answers daemon.status with starting and rejects other operations as unavailable until released", async () => {
        const env = await hermetic();
        const daemon = start({ hermetic: env, holdStart: true });

        const status = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
        assert.equal(status.phase, "starting");
        await assert.rejects(
            daemon.invoke("conversations.list", {}),
            (error: unknown) => error instanceof ServiceError && error.code === "unavailable",
        );

        daemon.release();
        await daemon.ready;
        const listed = (await daemon.invoke("conversations.list", {})) as { isFrontDesk: boolean }[];
        assert.deepEqual(
            listed.filter((conversation) => !conversation.isFrontDesk),
            [],
        );
    });
});

describe("private permissions", () => {
    it("creates missing directories with mode 0700 and the database file with mode 0600", async () => {
        const base = await hermetic();
        const fresh = {
            ...base,
            configDir: join(base.root, "fresh", "config"),
            stateDir: join(base.root, "fresh", "state"),
            dataDir: join(base.root, "fresh", "data"),
            runtimeDir: join(base.root, "fresh", "runtime"),
        };
        const daemon = start({ hermetic: fresh });

        await daemon.ready;

        for (const dir of [fresh.configDir, fresh.stateDir, fresh.dataDir, fresh.runtimeDir]) {
            assert.equal(await modeOf(dir), OWNER_ONLY_DIRECTORY_MODE, dir);
        }
        assert.equal(await modeOf(join(fresh.stateDir, DATABASE_FILE_NAME)), OWNER_ONLY_FILE_MODE);
    });
});

describe("component start", () => {
    it("gives a starting component the catalogue, through which it invokes daemon.status", async () => {
        const env = await hermetic();
        const caller: Caller = { actor: { kind: "team_member" } };
        const { promise: statusSeen, resolve, reject } = Promise.withResolvers<DaemonStatus>();
        const probe: DaemonComponent = {
            name: "probe",
            async start(ctx) {
                try {
                    resolve((await ctx.catalogue.invoke("daemon.status", {}, caller)) as DaemonStatus);
                } catch (error) {
                    reject(error);
                }
            },
        };
        const daemon = runDaemon({
            flags: {
                configDir: env.configDir,
                stateDir: env.stateDir,
                dataDir: env.dataDir,
                runtimeDir: env.runtimeDir,
            },
            env: env.env,
            homeDir: env.root,
            logger: createLogger({ stream: { write: () => true } }),
            components: [probe],
        });
        inProcessDaemons.push(daemon);

        const status = await statusSeen;

        assert.equal(status.phase, "starting");
    });
});
