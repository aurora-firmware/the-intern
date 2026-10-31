import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const caller = { actor: { kind: "team_member" as const } };
const quietLogger = createLogger({ stream: { write: () => true } });

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

type Listing = { path: string; kind: "registered" | "role_default"; role?: string };
type Started = {
    agents: Awaited<ReturnType<typeof createAgentsComponent>>;
    daemon: RunningDaemon;
    invoke(name: string, input: unknown): Promise<unknown>;
    listed(): Promise<Listing[]>;
};

async function start(env: HermeticEnv): Promise<Started> {
    const agents = await createAgentsComponent({ logger: quietLogger });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component],
        operations: agents.operations,
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, caller);
    const listed = async () => ((await invoke("workspaces.list", {})) as { workspaces: Listing[] }).workspaces;
    return { agents, daemon, invoke, listed };
}

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

async function folder(env: HermeticEnv, name: string, mode = 0o700): Promise<string> {
    const path = join(env.root, name);
    await mkdir(path);
    await chmod(path, mode);
    return path;
}

// The hermetic pi agent folder names no default model, so a seat needs one that resolves.
const SEAT_MODEL = "amazon-bedrock/amazon.nova-lite-v1:0";
const seatWorkspace = (started: Started, path: string) =>
    started.agents.runtime().catalog.seatFor("gp", { model: SEAT_MODEL, workspace: path }).workspace;

const configFile = (env: HermeticEnv) => join(env.configDir, "config.toml");
const fileText = (env: HermeticEnv) => readFile(configFile(env), "utf8").catch(() => "");

async function refusal(action: Promise<unknown>): Promise<ServiceError> {
    try {
        await action;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
        return error;
    }
    throw new assert.AssertionError({ message: "expected the operation to be refused" });
}

describe("the workspace operations", () => {
    it("lists the default workspaces of the shipped roles through workspaces.list", async () => {
        const { listed } = await start(await hermetic());

        const roles = (await listed()).filter((entry) => entry.kind === "role_default").map((entry) => entry.role);
        assert.deepEqual(roles.sort(), ["bob", "gp"]);
    });

    it("writes a registered folder to the file, lists it and lets a seat name it at once", async () => {
        const env = await hermetic();
        const started = await start(env);
        const { invoke, listed } = started;
        const path = await folder(env, "project");

        await invoke("workspaces.register", { path });

        assert.ok((await fileText(env)).includes(path));
        assert.ok((await listed()).some((entry) => entry.path === path && entry.kind === "registered"));
        assert.equal(seatWorkspace(started, path), path);
    });

    it("keeps a registered folder after a restart", async () => {
        const env = await hermetic();
        const first = await start(env);
        const path = await folder(env, "project");
        await first.invoke("workspaces.register", { path });
        await first.daemon.stop();

        const second = await start(env);

        assert.ok((await second.listed()).some((entry) => entry.path === path));
    });

    it("returns the original result and writes nothing when workspaces.register repeats a path and key", async () => {
        const env = await hermetic();
        const { invoke, listed } = await start(env);
        const path = await folder(env, "project");

        const first = await invoke("workspaces.register", { path, idempotencyKey: "k1" });
        const afterFirst = await fileText(env);
        const second = await invoke("workspaces.register", { path, idempotencyKey: "k1" });

        assert.deepEqual(second, first);
        assert.equal(await fileText(env), afterFirst);
        assert.equal((await listed()).filter((entry) => entry.path === path).length, 1);
    });

    it("returns the original result for a repeated key even after the folder was unregistered", async () => {
        const env = await hermetic();
        const { invoke, listed } = await start(env);
        const path = await folder(env, "project");
        const first = await invoke("workspaces.register", { path, idempotencyKey: "k1" });
        await invoke("workspaces.unregister", { path });

        const again = await invoke("workspaces.register", { path, idempotencyKey: "k1" });

        assert.deepEqual(again, first);
        assert.ok(!(await listed()).some((entry) => entry.path === path));
    });

    it("writes nothing when a registered path is registered again without a key", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);
        const path = await folder(env, "project");
        await invoke("workspaces.register", { path });
        const before = await fileText(env);

        await invoke("workspaces.register", { path });

        assert.equal(await fileText(env), before);
    });

    it("refuses an empty idempotency key as invalid_input", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);
        const path = await folder(env, "project");

        const error = await refusal(invoke("workspaces.register", { path, idempotencyKey: "" }));

        assert.equal(error.code, "invalid_input");
        assert.equal(await fileText(env), "");
    });

    it("refuses input that is not shaped like a path as invalid_input", async () => {
        const { invoke } = await start(await hermetic());

        for (const operation of ["workspaces.register", "workspaces.unregister"]) {
            const error = await refusal(invoke(operation, { path: 5 }));
            assert.equal(error.code, "invalid_input", operation);
        }
    });

    it("refuses a folder that is relative, missing, a file or open to the group, naming path and reason", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);
        const aFile = join(env.root, "plain-file");
        await writeFile(aFile, "x");
        const open = await folder(env, "open", 0o770);
        const cases = [
            { path: "relative/dir", reason: /not absolute/ },
            { path: join(env.root, "missing"), reason: /does not exist/ },
            { path: aFile, reason: /not a directory/ },
            { path: open, reason: /accessible to the group or others/ },
        ];

        for (const { path, reason } of cases) {
            const error = await refusal(invoke("workspaces.register", { path }));
            assert.equal(error.code, "invalid_input", path);
            assert.ok(error.message.includes(path), path);
            assert.match(error.message, reason);
        }
        assert.equal(await fileText(env), "");
    });

    it("refuses with conflict naming the file when the file changed on disk, applying nothing", async () => {
        const env = await hermetic();
        const { invoke, listed } = await start(env);
        const path = await folder(env, "project");
        await writeFile(configFile(env), "# edited by hand\n");

        const error = await refusal(invoke("workspaces.register", { path }));

        assert.equal(error.code, "conflict");
        assert.ok(error.message.includes(configFile(env)));
        assert.ok(!(await listed()).some((entry) => entry.path === path));
        assert.equal(await fileText(env), "# edited by hand\n");
    });

    it("refuses with internal naming the file when the file can't be written", async () => {
        const env = await hermetic();
        const { invoke, listed } = await start(env);
        const path = await folder(env, "project");
        // A missing directory makes the write fail for every user; root ignores a read-only directory mode.
        await rm(env.configDir, { recursive: true });

        const error = await refusal(invoke("workspaces.register", { path }));

        assert.equal(error.code, "internal");
        assert.ok(error.message.includes(configFile(env)));
        assert.ok(!(await listed()).some((entry) => entry.path === path));
    });

    it("refuses with conflict naming the role when a role's default workspace is unregistered", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);
        const path = await folder(env, "project");
        await invoke("workspaces.register", { path });
        await invoke("roles.create", {
            name: "reviewer",
            instructions: "Review.",
            tools: [],
            skills: [],
            workspace: path,
        });
        const before = await fileText(env);

        const error = await refusal(invoke("workspaces.unregister", { path }));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /reviewer/);
        assert.equal(await fileText(env), before);
    });

    it("refuses with conflict naming the reason when a per-role default workspace is unregistered", async () => {
        const env = await hermetic();
        const { invoke, listed } = await start(env);
        const path = (await listed()).find((entry) => entry.role === "bob")?.path;
        assert.ok(path !== undefined);

        const error = await refusal(invoke("workspaces.unregister", { path }));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /default workspace/);
        assert.equal(await fileText(env), "");
        assert.ok((await listed()).some((entry) => entry.path === path));
    });

    it("removes an unregistered folder from the file, keeps it removed after a restart and refuses a seat naming it", async () => {
        const env = await hermetic();
        const first = await start(env);
        const path = await folder(env, "project");
        await first.invoke("workspaces.register", { path });

        await first.invoke("workspaces.unregister", { path });

        assert.ok(!(await fileText(env)).includes(path));
        assert.throws(() => seatWorkspace(first, path), /workspace.*project/);
        await first.daemon.stop();
        const second = await start(env);
        assert.ok(!(await second.listed()).some((entry) => entry.path === path));
        assert.throws(() => seatWorkspace(second, path), /workspace.*project/);
    });
});
