import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
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

type Role = { name: string; instructions: string; changed: boolean; shipped: boolean };
type Started = {
    agents: Awaited<ReturnType<typeof createAgentsComponent>>;
    daemon: RunningDaemon;
    invoke(name: string, input: unknown): Promise<unknown>;
    roles(): Promise<Role[]>;
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
    return { agents, daemon, invoke, roles: async () => ((await invoke("roles.list", {})) as { roles: Role[] }).roles };
}

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

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

const reviewer = { name: "reviewer", instructions: "Review the work.", tools: ["read"], skills: [] };

describe("the role operations", () => {
    it("lists the shipped roles bob and gp through roles.list", async () => {
        const { roles } = await start(await hermetic());

        assert.deepEqual(
            (await roles()).map((role) => role.name),
            ["bob", "gp"],
        );
    });

    it("writes create, change and remove to the file, lists them at once and keeps them after a restart", async () => {
        const env = await hermetic();
        const first = await start(env);

        await first.invoke("roles.create", reviewer);
        assert.match(await fileText(env), /reviewer/);
        assert.ok((await first.roles()).some((role) => role.name === "reviewer"));

        await first.invoke("roles.change", { name: "reviewer", instructions: "Review hard." });
        assert.equal((await first.roles()).find((role) => role.name === "reviewer")?.instructions, "Review hard.");

        await first.daemon.stop();
        const second = await start(env);
        assert.equal((await second.roles()).find((role) => role.name === "reviewer")?.instructions, "Review hard.");

        await second.invoke("roles.remove", { name: "reviewer" });
        assert.ok(!(await second.roles()).some((role) => role.name === "reviewer"));
        assert.doesNotMatch(await fileText(env), /reviewer/);
    });

    it("creates the role once and returns the original result when roles.create repeats an idempotency key", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);

        const first = await invoke("roles.create", { ...reviewer, idempotencyKey: "k1" });
        const second = await invoke("roles.create", { ...reviewer, idempotencyKey: "k1" });

        assert.deepEqual(second, first);
        assert.equal((await roles()).filter((role) => role.name === "reviewer").length, 1);
    });

    it("returns the original result for a repeated key even after the role was removed", async () => {
        const { invoke, roles } = await start(await hermetic());
        const first = await invoke("roles.create", { ...reviewer, idempotencyKey: "k1" });
        await invoke("roles.remove", { name: "reviewer" });

        const again = await invoke("roles.create", { ...reviewer, idempotencyKey: "k1" });

        assert.deepEqual(again, first);
        assert.ok(!(await roles()).some((role) => role.name === "reviewer"));
    });

    it("returns the role as the original result when a crash left it in the file before the key was recorded", async () => {
        const { agents, invoke, roles } = await start(await hermetic());
        const written = await agents.runtime().catalog.create(reviewer);

        const result = await invoke("roles.create", { ...reviewer, idempotencyKey: "k1" });

        assert.deepEqual(result, { role: written });
        assert.equal((await roles()).filter((role) => role.name === "reviewer").length, 1);
    });

    it("still refuses a key with a different definition for an existing name as a conflict", async () => {
        const { agents, invoke } = await start(await hermetic());
        await agents.runtime().catalog.create(reviewer);

        const error = await refusal(
            invoke("roles.create", { ...reviewer, instructions: "Other.", idempotencyKey: "k1" }),
        );

        assert.equal(error.code, "conflict");
    });

    it("refuses a repeated name without a key as a conflict", async () => {
        const { invoke } = await start(await hermetic());
        await invoke("roles.create", reviewer);

        const error = await refusal(invoke("roles.create", reviewer));

        assert.equal(error.code, "conflict");
    });

    it("refuses an empty idempotency key as invalid_input", async () => {
        const { invoke } = await start(await hermetic());

        const error = await refusal(invoke("roles.create", { ...reviewer, idempotencyKey: "" }));

        assert.equal(error.code, "invalid_input");
    });

    it("ends with invalid_input naming the role and the tool when the value is invalid, leaving the file unchanged", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);

        const error = await refusal(invoke("roles.create", { ...reviewer, tools: ["teleport"] }));

        assert.equal(error.code, "invalid_input");
        assert.match(error.message, /reviewer/);
        assert.match(error.message, /teleport/);
        assert.equal(await fileText(env), "");
    });

    it("ends with invalid_input when the input is not shaped like a role", async () => {
        const { invoke } = await start(await hermetic());

        const error = await refusal(invoke("roles.create", { name: "reviewer", instructions: 5 }));

        assert.equal(error.code, "invalid_input");
    });

    it("ends with not_found naming the role when the role is unknown", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);

        for (const operation of ["roles.change", "roles.restore", "roles.remove"]) {
            const error = await refusal(invoke(operation, { name: "nobody", instructions: "x" }));
            assert.equal(error.code, "not_found", operation);
            assert.match(error.message, /nobody/, operation);
        }
        assert.equal(await fileText(env), "");
    });

    it("ends with conflict naming the role when a shipped role is removed", async () => {
        const env = await hermetic();
        const { invoke } = await start(env);

        const error = await refusal(invoke("roles.remove", { name: "bob" }));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /bob/);
        assert.equal(await fileText(env), "");
    });

    it("ends with conflict naming the role and the referrer when a referenced role is removed, leaving the file unchanged", async () => {
        const env = await hermetic();
        const { agents, invoke, roles } = await start(env);
        await invoke("roles.create", reviewer);
        const before = await fileText(env);
        agents.runtime().catalog.addReferenceSource({
            name: "job-template",
            referrersOf: (role) => (role === "reviewer" ? ["nightly-review"] : []),
        });

        const error = await refusal(invoke("roles.remove", { name: "reviewer" }));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /reviewer/);
        assert.match(error.message, /nightly-review/);
        assert.equal(await fileText(env), before);
        assert.ok((await roles()).some((role) => role.name === "reviewer"));
    });

    it("removes the change from the file and lists the shipped values when a changed shipped role is restored", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        const shippedInstructions = (await roles()).find((role) => role.name === "gp")?.instructions;
        await invoke("roles.change", { name: "gp", instructions: "Something else." });
        assert.match(await fileText(env), /Something else/);

        await invoke("roles.restore", { name: "gp" });

        const gp = (await roles()).find((role) => role.name === "gp");
        assert.equal(gp?.instructions, shippedInstructions);
        assert.equal(gp?.changed, false);
        assert.doesNotMatch(await fileText(env), /Something else/);
    });

    it("refuses with conflict naming the file and applies nothing when the file changed on disk", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        await writeFile(configFile(env), "# edited by hand\n");

        const error = await refusal(invoke("roles.create", reviewer));

        assert.equal(error.code, "conflict");
        assert.ok(error.message.includes(configFile(env)));
        assert.ok(!(await roles()).some((role) => role.name === "reviewer"));
        assert.equal(await fileText(env), "# edited by hand\n");
    });

    it("refuses with internal naming the file and applies nothing when the file can't be written", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        // A missing directory makes the write fail for every user; root ignores a read-only directory mode.
        assert.equal(await fileText(env), "");
        await rm(env.configDir, { recursive: true });

        const error = await refusal(invoke("roles.create", reviewer));

        assert.equal(error.code, "internal");
        assert.ok(error.message.includes(configFile(env)));
        assert.ok(!(await roles()).some((role) => role.name === "reviewer"));
    });
});
