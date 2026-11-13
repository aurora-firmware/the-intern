import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { abortJobConversations } from "../../src/host/invocation.ts";
import { createSeatedConversation, readConversationMeta } from "../../src/host/seating.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { roleInstructionPath } from "../../src/skills/internal_folder.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const caller = { actor: { kind: "team_member" as const } };
const quietLogger = createLogger({ stream: { write: () => true } });

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Role = {
    name: string;
    instructions?: string;
    instructionsVersion?: string;
    instructionsMissing?: boolean;
    changed: boolean;
    shipped: boolean;
};
type FileAnnouncement = { path: string; kind: string };
type Started = {
    agents: Awaited<ReturnType<typeof createAgentsComponent>>;
    daemon: RunningDaemon;
    invoke(name: string, input: unknown): Promise<unknown>;
    roles(): Promise<Role[]>;
    announced: FileAnnouncement[];
    ctx(): ServiceContext;
    seatConversation(role: string, jobId: string): Promise<string>;
};

async function start(env: HermeticEnv): Promise<Started> {
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    fake.setResponses([() => fauxAssistantMessage("ok")]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const announced: FileAnnouncement[] = [];
    let captured: ServiceContext | undefined;
    const listener: DaemonComponent = {
        name: "file-change-listener",
        async checkModels(ctx) {
            ctx.fileChanges.onChange((change) => announced.push(change));
        },
        async start(ctx) {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, listener],
        operations: agents.operations,
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, caller);
    let conversationCount = 0;
    const ctx = () => {
        if (captured === undefined) throw new Error("the daemon has not started");
        return captured;
    };
    return {
        agents,
        daemon,
        invoke,
        announced,
        ctx,
        async seatConversation(role, jobId) {
            conversationCount += 1;
            const { conversationId } = await createSeatedConversation(ctx().host, {
                scope: "role-operations",
                key: `conversation-${conversationCount}`,
                job: { jobId, isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat: agents.runtime().catalog.seatFor(role),
                actor: { kind: "team_member", wayIn: "cli" },
            });
            return conversationId;
        },
        roles: async () => ((await invoke("roles.list", {})) as { roles: Role[] }).roles,
    };
}

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

const configFile = (env: HermeticEnv) => join(env.configDir, "config.toml");
const instructionFile = (env: HermeticEnv) => roleInstructionPath(env.dataDir, "reviewer");
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
    it("lists the shipped roles bob, gp and desk through roles.list", async () => {
        const { roles } = await start(await hermetic());

        assert.deepEqual(
            (await roles()).map((role) => role.name),
            ["bob", "gp", "desk"],
        );
    });

    it("writes create, change and remove to the file, lists them at once and keeps them after a restart", async () => {
        const env = await hermetic();
        const first = await start(env);

        await first.invoke("roles.create", reviewer);
        assert.match(await fileText(env), /reviewer/);
        assert.equal(await readFile(instructionFile(env), "utf8"), "Review the work.");
        assert.doesNotMatch(await fileText(env), /Review the work/);
        assert.ok((await first.roles()).some((role) => role.name === "reviewer"));

        await first.invoke("roles.change", { name: "reviewer", instructions: "Review hard." });
        assert.equal(await readFile(instructionFile(env), "utf8"), "Review hard.");
        assert.doesNotMatch(await fileText(env), /Review hard/);
        assert.equal((await first.roles()).find((role) => role.name === "reviewer")?.instructions, "Review hard.");

        await first.daemon.stop();
        const second = await start(env);
        assert.equal((await second.roles()).find((role) => role.name === "reviewer")?.instructions, "Review hard.");

        await second.invoke("roles.remove", { name: "reviewer" });
        assert.ok(!(await second.roles()).some((role) => role.name === "reviewer"));
        assert.doesNotMatch(await fileText(env), /reviewer/);
        await assert.rejects(readFile(instructionFile(env), "utf8"), { code: "ENOENT" });
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
        const { instructions, ...definition } = reviewer;
        const written = await agents.runtime().catalog.create(definition, { instructions });

        const result = await invoke("roles.create", { ...reviewer, idempotencyKey: "k1" });

        const listed = (await roles()).filter((role) => role.name === "reviewer");
        assert.deepEqual(result, {
            role: { ...written, instructions, instructionsVersion: listed[0]?.instructionsVersion },
        });
        assert.equal(listed.length, 1);
    });

    it("still refuses a key with a different definition for an existing name as a conflict", async () => {
        const { agents, invoke } = await start(await hermetic());
        const { instructions, ...definition } = reviewer;
        await agents.runtime().catalog.create(definition, { instructions });

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

    it("ends with conflict naming the role and leaves the file unchanged when desk is removed", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);

        const error = await refusal(invoke("roles.remove", { name: "desk" }));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /desk/);
        assert.equal(await fileText(env), "");
        assert.ok((await roles()).some((role) => role.name === "desk"));
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
        await invoke("roles.change", { name: "gp", instructions: "Something else.", tools: ["read"] });
        assert.equal((await roles()).find((role) => role.name === "gp")?.instructions, "Something else.");
        assert.match(await fileText(env), /\[roles\.gp\]/);

        await invoke("roles.restore", { name: "gp" });

        const gp = (await roles()).find((role) => role.name === "gp");
        assert.equal(gp?.instructions, shippedInstructions);
        assert.equal(gp?.changed, false);
        assert.doesNotMatch(await fileText(env), /\[roles\.gp\]/);
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

    it("guards a role's instructions with the token roles.list returned", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        await invoke("roles.create", reviewer);
        const token = (await roles()).find((role) => role.name === "reviewer")?.instructionsVersion;
        assert.equal(typeof token, "string");

        await invoke("roles.change", { name: "reviewer", instructions: "Review hard.", instructionsVersion: token });
        assert.equal(await readFile(instructionFile(env), "utf8"), "Review hard.");
        assert.doesNotMatch(await fileText(env), /Review hard/);

        await invoke("roles.remove", { name: "reviewer" });
        await assert.rejects(readFile(instructionFile(env), "utf8"), { code: "ENOENT" });
    });

    it("refuses conflict naming the file and keeps a hand edit when the token is old", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        await invoke("roles.create", reviewer);
        const token = (await roles()).find((role) => role.name === "reviewer")?.instructionsVersion;
        await writeFile(instructionFile(env), "Edited by hand.");

        const error = await refusal(
            invoke("roles.change", { name: "reviewer", instructions: "Review hard.", instructionsVersion: token }),
        );

        assert.equal(error.code, "conflict");
        assert.ok(error.message.includes(instructionFile(env)));
        assert.equal(await readFile(instructionFile(env), "utf8"), "Edited by hand.");
    });

    it("changes nothing in the table when the token is old", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        await invoke("roles.create", reviewer);
        const token = (await roles()).find((role) => role.name === "reviewer")?.instructionsVersion;
        await writeFile(instructionFile(env), "Edited by hand.");
        const before = await fileText(env);

        await refusal(
            invoke("roles.change", {
                name: "reviewer",
                instructions: "Review hard.",
                tools: ["bash"],
                instructionsVersion: token,
            }),
        );

        assert.equal(await fileText(env), before);
    });

    it("lists a team role whose file is missing with no instructions and marked missing", async () => {
        const env = await hermetic();
        const { invoke, roles } = await start(env);
        await invoke("roles.create", reviewer);
        await rm(instructionFile(env));

        const listed = (await roles()).find((role) => role.name === "reviewer");

        assert.equal(listed?.instructionsMissing, true);
        assert.equal("instructions" in (listed ?? {}), false);
        assert.equal("instructionsVersion" in (listed ?? {}), false);
    });

    it("announces files_changed with kind role for each file a role operation writes or removes", async () => {
        const env = await hermetic();
        const { invoke, announced } = await start(env);

        await invoke("roles.create", reviewer);
        await invoke("roles.change", { name: "reviewer", instructions: "Review hard." });
        await invoke("roles.remove", { name: "reviewer" });

        const expected = { path: instructionFile(env), kind: "role" };
        assert.deepEqual(
            announced.filter((change) => change.path === expected.path),
            [expected, expected, expected],
        );
    });

    it("announces files_changed with kind role for the file roles.restore writes", async () => {
        const env = await hermetic();
        const { invoke, announced } = await start(env);
        await invoke("roles.change", { name: "gp", instructions: "Something else." });
        announced.length = 0;

        await invoke("roles.restore", { name: "gp" });

        assert.deepEqual(announced, [{ path: roleInstructionPath(env.dataDir, "gp"), kind: "role" }]);
    });

    it("refuses conflict naming the conversation and keeps the role and its file while an open conversation is seated with it", async () => {
        const env = await hermetic();
        const { invoke, roles, seatConversation } = await start(env);
        await invoke("roles.create", reviewer);
        const conversationId = await seatConversation("reviewer", "job-1");

        const error = await refusal(invoke("roles.remove", { name: "reviewer" }));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /reviewer/);
        assert.ok(error.message.includes(conversationId));
        assert.ok((await roles()).some((role) => role.name === "reviewer"));
        assert.equal(await readFile(instructionFile(env), "utf8"), "Review the work.");
    });

    it("removes the role and deletes its file when the only conversations seated with it are closed", async () => {
        const env = await hermetic();
        const { invoke, roles, seatConversation, ctx } = await start(env);
        await invoke("roles.create", reviewer);
        await seatConversation("reviewer", "job-1");
        await abortJobConversations(ctx().host, "job-1");

        await invoke("roles.remove", { name: "reviewer" });

        assert.ok(!(await roles()).some((role) => role.name === "reviewer"));
        await assert.rejects(readFile(instructionFile(env), "utf8"), { code: "ENOENT" });
    });

    it("removes the role when an open conversation is seated with another role", async () => {
        const env = await hermetic();
        const { invoke, roles, seatConversation } = await start(env);
        await invoke("roles.create", reviewer);
        await seatConversation("gp", "job-1");

        await invoke("roles.remove", { name: "reviewer" });

        assert.ok(!(await roles()).some((role) => role.name === "reviewer"));
    });

    it("leaves the seated agent's tools, model, thinking level and workspace unchanged when its role is changed", async () => {
        const env = await hermetic();
        const { agents, invoke, seatConversation, ctx } = await start(env);
        await invoke("roles.create", reviewer);
        const conversationId = await seatConversation("reviewer", "job-1");
        const folder = join(env.root, "other-workspace");
        await mkdir(folder, { mode: 0o700 });
        await chmod(folder, 0o700);
        await agents.runtime().workspaces.register(folder);
        const before = (await readConversationMeta(ctx().host, conversationId))?.seat;

        await invoke("roles.change", {
            name: "reviewer",
            tools: ["bash"],
            model: `${before?.model}`,
            thinkingLevel: "low",
            workspace: folder,
        });

        const after = (await readConversationMeta(ctx().host, conversationId))?.seat;
        assert.deepEqual(after, before);
        assert.notEqual(before?.thinkingLevel, "low");
    });
});
