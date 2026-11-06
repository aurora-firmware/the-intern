import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const LOOPBACK = "127.0.0.1";
const NETWORK_CONFIG = `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`;
const webCaller = { actor: { kind: "team_member" as const, wayIn: "web interface" as const } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type Target = { socketPath: string } | { host: string; port: number };
type Answer = { status: number; headers: IncomingMessage["headers"]; body: Buffer };

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function get(target: Target, path: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const call = request({ ...target, method: "GET", path });
        call.once("error", reject);
        call.once("response", (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () =>
                resolve({
                    status: response.statusCode ?? 0,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                }),
            );
            response.once("error", reject);
        });
        call.end();
    });
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

function listening(fixture: Fixture): boolean {
    try {
        return fixture.target.port > 0;
    } catch {
        return false;
    }
}

async function countRows(folder: string, file: Buffer): Promise<{ jobs: number; worklog: number; history: number }> {
    const path = join(folder, "downloaded.sqlite");
    await writeFile(path, file);
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
        const count = (table: string) => (copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
        return { jobs: count("intern_jobs"), worklog: count("intern_worklog"), history: count("intern_history") };
    } finally {
        copy.close();
    }
}

type Fixture = {
    env: HermeticEnv;
    lines: string[];
    daemon: RunningDaemon;
    target: { host: string; port: number };
    socket: { socketPath: string };
    ctx(): ServiceContext;
};

/** A daemon with jobs on a fake model, both listeners, and `extra` components started after them. */
async function startDaemon(extra: DaemonComponent[] = [], hold?: Promise<void>): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.configDir, "config.toml"), NETWORK_CONFIG);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const answer = async () => {
        fake.appendResponses([answer]);
        await hold;
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const lines: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (chunk) => lines.push(String(chunk)) } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const listener = createNetworkListenerComponent({ freePort: true });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: [...agents.sections, networkSection],
        components: [agents.component, jobs.component, createLocalSocketComponent(), listener, probe, ...extra],
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
    daemons.push(daemon);
    const address = (): { host: string; port: number } => {
        const bound = listener.address();
        assert.ok(bound, "the network listener is running");
        return bound;
    };
    return {
        env,
        lines,
        daemon,
        get target() {
            return address();
        },
        socket: { socketPath: localSocketPath(env.runtimeDir) },
        ctx: () => captured as ServiceContext,
    };
}

async function readyDaemon(extra: DaemonComponent[] = [], hold?: Promise<void>): Promise<Fixture> {
    const fixture = await startDaemon(extra, hold);
    await waitFor(() => fixture.daemon.phase() === "ready", "the daemon to be ready");
    return fixture;
}

describe("GET /export on the network listener", () => {
    it("sends the whole database as an attachment while a job's run goes on and logs the download", async () => {
        const release = Promise.withResolvers<void>();
        const fixture = await readyDaemon([], release.promise);
        const job = (await fixture.daemon.catalogue.invoke("jobs.create", { text: "do it" }, webCaller)) as {
            id: string;
            leadConversation: string;
        };
        await fixture.daemon.catalogue.invoke("jobs.worklog.add", { job: job.id, text: "a note" }, webCaller);
        const isBusy = async () => (await fixture.ctx().host.conversationInfo(job.leadConversation))?.busy === true;
        await waitFor(isBusy, "the lead's run to be held");

        const answer = await get(fixture.target, "/export");

        assert.equal(answer.status, 200);
        assert.equal(answer.headers["content-type"], "application/vnd.sqlite3");
        assert.match(String(answer.headers["content-disposition"]), /^attachment/);
        assert.equal(answer.headers["content-length"], String(answer.body.length));
        const counts = await countRows(fixture.env.root, answer.body);
        assert.equal(counts.jobs, 1);
        assert.equal(counts.worklog, 1);
        assert.ok(counts.history >= 1);
        assert.equal(await isBusy(), true, "the run goes on during the download");
        const logged = fixture.lines.find((line) => line.includes("export download"));
        assert.ok(logged, "the daemon logs the download");
        assert.match(logged, /wayIn="web interface"/);
        assert.match(logged, new RegExp(`remoteAddress=${LOOPBACK}`));
        assert.match(logged, /remotePort=\d+/);
        release.resolve();
        await waitFor(async () => !(await isBusy()), "the held run to finish");
    });

    it("suggests the file name from the state directory's last folder and the UTC date", async () => {
        const fixture = await readyDaemon();
        const before = new Date().toISOString().slice(0, 10);

        const answer = await get(fixture.target, "/export");

        const after = new Date().toISOString().slice(0, 10);
        const instance = basename(fixture.env.stateDir).replace(/[^A-Za-z0-9._-]/g, "");
        const names = new Set([before, after].map((date) => `the-intern-${instance}-${date}.sqlite`));
        const match = /^attachment; filename="(.+)"$/.exec(String(answer.headers["content-disposition"]));
        assert.ok(match, "the disposition names a file");
        assert.ok(names.has(match[1] as string), `${match[1]} is one of ${[...names]}`);
    });

    it("answers 404 on the local socket", async () => {
        const fixture = await readyDaemon();

        const answer = await get(fixture.socket, "/export");

        assert.equal(answer.status, 404);
        assert.equal(answer.headers["content-type"], "application/json; charset=utf-8");
    });

    it("answers 503 unavailable and makes no folder while the daemon is starting", async () => {
        const startGate = Promise.withResolvers<void>();
        const slow: DaemonComponent = { name: "slow start", start: () => startGate.promise };
        const fixture = await startDaemon([slow]);
        await waitFor(() => fixture.daemon.phase() === "starting" && listening(fixture), "the listener to be up");

        const answer = await get(fixture.target, "/export");

        assert.equal(answer.status, 503);
        assert.equal(JSON.parse(answer.body.toString()).error.code, "unavailable");
        assert.equal(await exists(join(fixture.env.stateDir, "exports")), false);
        startGate.resolve();
    });

    it("answers 503 unavailable and makes no folder while the daemon is stopping", async () => {
        const stopGate = Promise.withResolvers<void>();
        const slow: DaemonComponent = { name: "slow stop", stop: () => stopGate.promise };
        const fixture = await readyDaemon([slow]);
        const stopped = fixture.daemon.stop();
        await waitFor(() => fixture.daemon.phase() === "stopping", "the daemon to be stopping");

        const answer = await get(fixture.target, "/export");

        assert.equal(answer.status, 503);
        assert.equal(JSON.parse(answer.body.toString()).error.code, "unavailable");
        assert.equal(await exists(join(fixture.env.stateDir, "exports")), false);
        stopGate.resolve();
        await stopped;
    });
});
