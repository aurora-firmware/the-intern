import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { loadConfig } from "../../src/config/config_file.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
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

async function start(env: HermeticEnv): Promise<RunningDaemon> {
    const agents = await createAgentsComponent({ logger: quietLogger });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: [...agents.sections, networkSection],
        components: [agents.component],
        operations: agents.operations,
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("the daemon did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return daemon;
}

describe("the network settings in the configuration file", () => {
    it("keeps the network section with the same address and port after a role change and a restart", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const file = join(env.configDir, "config.toml");
        await writeFile(file, '[network]\naddress = "192.168.1.5"\nport = 8080\n');

        const first = await start(env);
        await first.catalogue.invoke(
            "roles.create",
            { name: "reviewer", instructions: "Review the work.", tools: ["read"], skills: [] },
            caller,
        );
        await first.catalogue.invoke("roles.change", { name: "reviewer", instructions: "Review hard." }, caller);
        await first.stop();

        const text = await readFile(file, "utf8");
        assert.match(text, /Review hard\./);
        assert.match(text, /\[network\]\naddress = "192\.168\.1\.5"\nport = 8080/);

        const second = await start(env);
        assert.equal(second.phase(), "ready");
        const agents = await createAgentsComponent({ logger: quietLogger });
        const reloaded = await loadConfig(file, [...agents.sections, networkSection]);
        assert.deepEqual(reloaded.values.get("network"), { address: "192.168.1.5", port: 8080 });
    });
});
