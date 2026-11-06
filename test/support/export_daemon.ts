import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const NETWORK_CONFIG = `[network]\naddress = "127.0.0.1"\nport = 8080\n`;

export const webCaller = { actor: { kind: "team_member" as const, wayIn: "web interface" as const } };

export type ExportDaemon = {
    env: HermeticEnv;
    daemon: RunningDaemon;
    target: { host: string; port: number };
    ctx(): ServiceContext;
    /** Lets the lead's held run finish. */
    release(): void;
    stop(): Promise<void>;
};

export async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** A ready daemon with jobs on a fake model whose first run is held until `release`, and a network listener. */
export async function startExportDaemon(): Promise<ExportDaemon> {
    const env = await createHermeticEnv();
    await writeFile(join(env.configDir, "config.toml"), NETWORK_CONFIG);
    const hold = Promise.withResolvers<void>();
    const fake: FauxProviderRegistration = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fake.setResponses([
        async () => {
            await hold.promise;
            return fauxAssistantMessage("done");
        },
    ]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const logger = createLogger({ verbose: false, stream: { write: () => true } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const listener = createNetworkListenerComponent({ freePort: true });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: [...agents.sections, networkSection],
        components: [
            agents.component,
            jobs.component,
            createLocalSocketComponent(),
            listener,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations],
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
    await waitFor(() => daemon.phase() === "ready", "the daemon to be ready");
    const bound = listener.address();
    assert.ok(bound, "the network listener is running");
    return {
        env,
        daemon,
        target: bound,
        ctx: () => captured as ServiceContext,
        release: () => hold.resolve(),
        async stop() {
            hold.resolve();
            await daemon.stop();
            fake.unregister();
            await env.dispose();
        },
    };
}
