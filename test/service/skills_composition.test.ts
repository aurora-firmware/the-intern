import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { manifestPath } from "../../src/skills/internal_folder.ts";
import { createSkillsComponent, type SkillsComponent } from "../../src/skills/skills_component.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const quietLogger = createLogger({ stream: { write: () => true } });

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

type Agents = Awaited<ReturnType<typeof createAgentsComponent>>;

async function startReady(agents: Agents): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = runDaemon({
        flags: {
            configDir: env.configDir,
            stateDir: env.stateDir,
            dataDir: env.dataDir,
            runtimeDir: env.runtimeDir,
        },
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
    return env;
}

const HOOKS = ["prepareFiles", "checkModels", "ensureWorkspaces", "repair", "afterResume", "start", "stop"] as const;

/** A skills component whose hooks record their name in `calls` before running as they did. */
function recordingSkills(calls: string[]): SkillsComponent {
    const skills = createSkillsComponent({ logger: quietLogger });
    const inner = skills.component;
    const recorded: Record<string, unknown> = { name: inner.name };
    for (const hook of HOOKS) {
        recorded[hook] = async (...args: unknown[]) => {
            calls.push(hook);
            const run = inner[hook] as ((...input: unknown[]) => Promise<unknown>) | undefined;
            return run?.(...args);
        };
    }
    return { ...skills, component: recorded as DaemonComponent };
}

describe("the agents component holding the skills component", () => {
    it("prepares the internal folder and offers the skills section without a skills component passed", async () => {
        const agents = await createAgentsComponent({ logger: quietLogger });

        const env = await startReady(agents);

        assert.ok(agents.sections.some((section) => section.name === "skills"));
        assert.ok((await stat(manifestPath(env.dataDir))).isFile());
        assert.ok((await stat(join(env.dataDir, "instructions"))).isDirectory());
    });

    it("exposes the skills component it was given as skills", async () => {
        const skills = createSkillsComponent({ logger: quietLogger });

        const agents = await createAgentsComponent({ logger: quietLogger, skills });

        assert.equal(agents.skills, skills);
    });

    it("exposes a skills component of its own when none is given", async () => {
        const agents = await createAgentsComponent({ logger: quietLogger });

        assert.equal(agents.skills.component.name, "skills");
    });

    it("begins sections, operations and extensions with those of the skills component", async () => {
        const skills = createSkillsComponent({ logger: quietLogger });
        const extension = { name: "test.skills-extension" } as NonNullable<DaemonComponent["extensions"]>[number];
        skills.operations.push({ name: "test.skills-operation" } as (typeof skills.operations)[number]);
        skills.component.extensions = [extension];

        const agents = await createAgentsComponent({ logger: quietLogger, skills });

        assert.equal(agents.sections[0], skills.sections[0]);
        assert.equal(agents.operations[0], skills.operations[0]);
        assert.equal(agents.component.extensions?.[0], extension);
        assert.ok((agents.component.extensions?.length ?? 0) > 1);
        assert.ok(agents.operations.length > 1);
    });

    it("runs every hook of the skills component, and its stop last", async () => {
        const calls: string[] = [];
        const agents = await createAgentsComponent({ logger: quietLogger, skills: recordingSkills(calls) });

        await startReady(agents);
        const daemon = daemons.pop();
        await daemon?.stop();

        assert.deepEqual(calls, [...HOOKS]);
    });

    it("runs the skills hook before the agents hook of the same name", async () => {
        const seen: string[] = [];
        const skills = recordingSkills([]);
        const checkModels = skills.component.checkModels;
        const ensureWorkspaces = skills.component.ensureWorkspaces;
        const agents = await createAgentsComponent({ logger: quietLogger, skills });
        skills.component.checkModels = async (ctx) => {
            try {
                agents.runtime();
            } catch {
                seen.push("no runtime at checkModels");
            }
            await checkModels?.(ctx);
        };
        skills.component.ensureWorkspaces = async (ctx) => {
            const exists = await stat(join(ctx.dirs.dataDir, "workspaces", "bob")).then(
                () => true,
                () => false,
            );
            seen.push(exists ? "workspace made before ensureWorkspaces" : "no workspace at ensureWorkspaces");
            await ensureWorkspaces?.(ctx);
        };

        await startReady(agents);

        assert.deepEqual(seen, ["no runtime at checkModels", "no workspace at ensureWorkspaces"]);
    });

    it("reaches the agents runtime through connectAgents", async () => {
        const skills = createSkillsComponent({ logger: quietLogger });
        let connected: (() => unknown) | undefined;
        const original = skills.connectAgents;
        skills.connectAgents = (runtime) => {
            connected = runtime;
            original(runtime);
        };

        const agents = await createAgentsComponent({ logger: quietLogger, skills });
        await startReady(agents);

        assert.equal(connected?.(), agents.runtime());
        assert.equal(skills.agentsRuntime(), agents.runtime());
    });
});
