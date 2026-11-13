import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
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

const hasRuntime = (agents: Agents): boolean => {
    try {
        agents.runtime();
        return true;
    } catch {
        return false;
    }
};

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

    it("runs the skills hooks once each, in the daemon's order, with stop at the end", async () => {
        const calls: string[] = [];
        const agents = await createAgentsComponent({ logger: quietLogger, skills: recordingSkills(calls) });

        await startReady(agents);
        await daemons.pop()?.stop();

        assert.deepEqual(calls, [...HOOKS]);
    });

    it("returns the configuration the skills prepareFiles returns", async () => {
        const skills = createSkillsComponent({ logger: quietLogger });
        const sentinel = { sentinel: true } as unknown as Awaited<
            ReturnType<NonNullable<DaemonComponent["prepareFiles"]>>
        >;
        skills.component.prepareFiles = async () => sentinel;
        const agents = await createAgentsComponent({ logger: quietLogger, skills });

        const returned = await agents.component.prepareFiles?.(
            {} as Parameters<NonNullable<DaemonComponent["prepareFiles"]>>[0],
        );

        assert.equal(returned, sentinel);
    });

    it("runs the skills hook before the agents hook of the same name, and its stop after the agents stop", async () => {
        const log: string[] = [];
        const skills = recordingSkills([]);
        const inner = skills.component;
        const agents = await createAgentsComponent({ logger: quietLogger, skills });
        // The agents component's own work is seen through what it changes: its runtime, its default workspaces and
        // its report delivery's subscription to the harness commits, which it drops again on stop.
        const hooks = {
            checkModels: inner.checkModels,
            ensureWorkspaces: inner.ensureWorkspaces,
            start: inner.start,
            stop: inner.stop,
        };
        inner.checkModels = async (ctx) => {
            log.push(hasRuntime(agents) ? "agents runtime before skills checkModels" : "skills checkModels");
            const harness = internalHarness(ctx.host);
            const subscribe = harness.subscribeCommits.bind(harness);
            harness.subscribeCommits = (listener) => {
                // Only the subscriptions made once the skills start has run are the report delivery's.
                const owner = log.includes("skills start") ? "agents" : "other";
                log.push(`${owner} subscribes`);
                const unsubscribe = subscribe(listener);
                return () => {
                    log.push(`${owner} unsubscribes`);
                    unsubscribe();
                };
            };
            await hooks.checkModels?.(ctx);
        };
        inner.ensureWorkspaces = async (ctx) => {
            const path = join(ctx.dirs.dataDir, "workspaces", "bob");
            const exists = await stat(path).then(
                () => true,
                () => false,
            );
            log.push(exists ? "agents workspace before skills ensureWorkspaces" : "skills ensureWorkspaces");
            await hooks.ensureWorkspaces?.(ctx);
        };
        inner.start = async (ctx) => {
            log.push("skills start");
            await hooks.start?.(ctx);
        };
        inner.stop = async () => {
            log.push("skills stop");
            await hooks.stop?.();
        };

        await startReady(agents);
        await daemons.pop()?.stop();

        // The report delivery watches the instance and the conversation documents: two subscriptions, both dropped.
        assert.deepEqual(
            log.filter((entry) => !entry.startsWith("other")),
            [
                "skills checkModels",
                "skills ensureWorkspaces",
                "skills start",
                "agents subscribes",
                "agents subscribes",
                "agents unsubscribes",
                "agents unsubscribes",
                "skills stop",
            ],
        );
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
