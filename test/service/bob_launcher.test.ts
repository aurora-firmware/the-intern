/**
 * An agent's `bash` reaches its own instance through `bob` (S-008 REQ-014): the launcher the daemon writes at startup,
 * the conversation id in the environment, and `bob status` answered by the daemon that runs the agent.
 */
import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(20_000);
const OWNER_ONLY_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const caller = { actor: { kind: "team_member" as const, wayIn: "command line" as const } };

const fakes: FauxProviderRegistration[] = [];
const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        await Promise.race([daemon.stop(), new Promise((resolve) => setTimeout(resolve, STOP_BOUND_MS))]);
    }
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Started = {
    env: HermeticEnv;
    daemon: RunningDaemon;
    runBash(command: string): Promise<{ output: string; conversationId: string }>;
};

// The fake model makes one bash call per job and keeps the text of its result.
async function startDaemonWithFakeModel(): Promise<Started> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider();
    fakes.push(fake);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: fake.getModel().id }),
    );
    const quiet = createLogger({ stream: { write: () => true } });
    const agents = await createAgentsComponent({ logger: quiet });
    const jobs = await createJobsComponent({ agents, logger: quiet });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quiet,
        sections: agents.sections,
        components: [agents.component, jobs.component, createLocalSocketComponent()],
        operations: [...agents.operations, ...jobs.operations],
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation);
            runtime.models.registerNativeProvider(
                createProvider({
                    id: fake.getModel().provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_MS;
    while (daemon.phase() !== "ready") {
        assert.ok(Date.now() < deadline, "the daemon became ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let jobNumber = 0;
    const runBash = async (command: string) => {
        let output = "";
        let seen: () => void = () => {};
        const answered = new Promise<void>((resolve) => {
            seen = resolve;
        });
        const call: FauxResponseFactory = async () =>
            fauxAssistantMessage([fauxToolCall("bash", { command } as never)], { stopReason: "toolUse" });
        const afterCall: FauxResponseFactory = async (context) => {
            const result = context.messages.findLast((message) => message.role === "toolResult");
            output =
                result?.role === "toolResult"
                    ? result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
                    : "";
            seen();
            return fauxAssistantMessage("done");
        };
        fake.setResponses([call, afterCall]);
        jobNumber += 1;
        const created = (await daemon.catalogue.invoke(
            "jobs.create",
            { text: `job ${jobNumber}`, role: "gp" },
            caller,
        )) as { leadConversation?: string };
        assert.ok(created.leadConversation, "the job has a lead conversation");
        await Promise.race([
            answered,
            new Promise((_, reject) => setTimeout(() => reject(new Error("the model saw no bash result")), WAIT_MS)),
        ]);
        return { output, conversationId: created.leadConversation };
    };
    return { env, daemon, runBash };
}

describe("the bob launcher", () => {
    it("is written to <runtime dir>/bin/bob with mode 0700 when the daemon starts", async () => {
        const { env } = await startDaemonWithFakeModel();

        const launcher = await stat(join(env.runtimeDir, "bin", "bob"));

        assert.equal(launcher.mode & PERMISSION_BITS, OWNER_ONLY_MODE);
        assert.equal((await stat(join(env.runtimeDir, "bin"))).mode & PERMISSION_BITS, OWNER_ONLY_MODE);
    });

    it("prints the conversation id of the agent whose bash runs echo $BOB_CONVERSATION_ID", async () => {
        const { runBash } = await startDaemonWithFakeModel();

        const { output, conversationId } = await runBash("echo $BOB_CONVERSATION_ID");

        assert.equal(output.trim(), conversationId);
    });

    it("answers bob status --json from the daemon that runs the agent", async () => {
        const { env, runBash } = await startDaemonWithFakeModel();

        const { output } = await runBash("bob status --json");

        const status = JSON.parse(output) as DaemonStatus;
        assert.equal(status.phase, "ready");
        assert.equal(status.instance.runtimeDir, env.runtimeDir);
    });
});
