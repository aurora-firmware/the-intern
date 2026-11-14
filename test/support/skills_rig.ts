/**
 * An in-process daemon for the skills and instructions service tests (S-008): the agents component holding the rig's own
 * skills component, the jobs and desk components, the local socket and the fake model, on a hermetic environment. It is
 * written with a chosen `config.toml`, records the system text of each model request per conversation, and can restart
 * on the same directories.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { ProviderDoc } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { parseConversationId } from "../../src/host/conversation_id.ts";
import { type HarnessHost, internalHarness } from "../../src/host/harness_host.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createSkillsComponent } from "../../src/skills/skills_component.ts";
import { createFakeModel, type FakeReply, type FakeTranscript } from "./fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const OWNER_ONLY_MODE = 0o700;
/** Operations such as `jobs.create` refuse the in-process way in, so calls are made as a team member at the command line. */
const TEAM_MEMBER: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

type ConfigToml = string | ((dirs: HermeticEnv) => string);

export type SkillsRigOptions = {
    /** The text of `config.toml`, written before each start; empty by default. */
    configToml?: ConfigToml;
    /** The folder the shipped instructions and skills are read from; the installed ones by default. */
    shippedRoot?: string;
    /** The fake model's reply to a transcript; "ok" by default. */
    reply?: (transcript: FakeTranscript) => FakeReply;
};

export type SkillsRig = {
    /** The hermetic directories: `root`, `configDir`, `stateDir`, `dataDir`, `runtimeDir` and `piAgentDir`. */
    dirs: HermeticEnv;
    /** Runs an operation as a team member at the command line. */
    invoke(op: string, input?: unknown): Promise<unknown>;
    /** The system text of each model request the conversation has made so far, oldest first. */
    systemPrompts(conversationId: string): Promise<string[]>;
    /** Stops the daemon and starts another on the same directories, with new `config.toml` text when given. */
    restart(configToml?: ConfigToml): Promise<void>;
    /** Stops the daemon and removes the rig's directories and fake model. */
    stop(): Promise<void>;
    /** Writes `<folder>/<name>/SKILL.md` with the name and description, and returns the skill's folder. */
    writeSkill(folder: string, name: string, description: string): Promise<string>;
    /** Makes the folder (and its parents) with owner-only access and returns its path. */
    ownerOnlyFolder(path: string): Promise<string>;
};

/** Starts the daemon and returns when it is ready; a startup that fails makes this throw. */
export async function startSkillsRig(options: SkillsRigOptions = {}): Promise<SkillsRig> {
    const dirs = await createHermeticEnv();
    // A request carries its conversation's provider session id, which the conversation's `ProviderDoc` also holds.
    const promptsBySession = new Map<string, string[]>();
    const fake = createFakeModel(options.reply ?? (() => "ok"), {
        onSystemPrompt: (text, sessionId) => {
            if (sessionId === undefined) return;
            promptsBySession.set(sessionId, [...(promptsBySession.get(sessionId) ?? []), text]);
        },
    });
    const provider = fake.getModel().provider;
    await writeFile(
        join(dirs.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    const logger = createLogger({ stream: { write: () => true } });
    let current: RunningDaemon | undefined;
    let host: HarnessHost | undefined;

    const writeConfig = (configToml: ConfigToml) =>
        writeFile(join(dirs.configDir, "config.toml"), typeof configToml === "string" ? configToml : configToml(dirs));

    const launch = async (): Promise<void> => {
        const skills = createSkillsComponent({
            logger,
            ...(options.shippedRoot !== undefined && { shippedRoot: options.shippedRoot }),
        });
        const agents = await createAgentsComponent({ logger, skills });
        const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
        const desk = await createDeskComponent({ agents, jobs, logger });
        const daemon = runDaemon({
            flags: {
                configDir: dirs.configDir,
                stateDir: dirs.stateDir,
                dataDir: dirs.dataDir,
                runtimeDir: dirs.runtimeDir,
            },
            env: dirs.env,
            homeDir: dirs.root,
            logger,
            sections: agents.sections,
            components: [
                agents.component,
                {
                    name: "skills-rig",
                    checkModels: async (ctx) => {
                        host = ctx.host;
                    },
                },
                jobs.component,
                desk.component,
                createLocalSocketComponent(),
            ],
            operations: [...agents.operations, ...jobs.operations, ...desk.operations],
            prepareModels: (runtime) => {
                const implementation = getApiProvider(fake.api);
                assert.ok(implementation, "the fake model's api is registered");
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
        current = daemon;
        let hasExited = false;
        void daemon.exited.then(() => {
            hasExited = true;
        });
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (daemon.phase() !== "ready") {
            if (hasExited) throw new Error("the daemon exited before it was ready");
            if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to be ready");
            await sleep(POLL_INTERVAL_MS);
        }
    };

    const requireDaemon = (): RunningDaemon => {
        assert.ok(current, "the rig has started a daemon");
        return current;
    };
    const stopCurrent = async (): Promise<void> => {
        if (current) await Promise.race([current.stop(), sleep(STOP_BOUND_MS)]);
    };

    // A conversation that has made no request has no provider session yet, so it has no prompts.
    const systemPrompts = async (conversationId: string): Promise<string[]> => {
        assert.ok(host, "the rig has started a daemon");
        const id = parseConversationId(conversationId);
        if (id === undefined) return [];
        const state = await internalHarness(host).snapshot(ProviderDoc, id, BACKGROUND_CONTEXT);
        return state === undefined ? [] : (promptsBySession.get(state.sessionId) ?? []);
    };

    await writeConfig(options.configToml ?? "");
    try {
        await launch();
    } catch (error) {
        await stopCurrent();
        fake.unregister();
        await dirs.dispose();
        throw error;
    }
    return {
        dirs,
        invoke: (op, input = {}) => requireDaemon().catalogue.invoke(op, input, TEAM_MEMBER),
        systemPrompts,
        async restart(configToml) {
            await stopCurrent();
            if (configToml !== undefined) await writeConfig(configToml);
            await launch();
        },
        async stop() {
            await stopCurrent();
            fake.unregister();
            await dirs.dispose();
        },
        async writeSkill(folder, name, description) {
            const skillDir = join(folder, name);
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                join(skillDir, "SKILL.md"),
                `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
            );
            return skillDir;
        },
        async ownerOnlyFolder(path) {
            await mkdir(path, { recursive: true, mode: OWNER_ONLY_MODE });
            await chmod(path, OWNER_ONLY_MODE);
            return path;
        },
    };
}
