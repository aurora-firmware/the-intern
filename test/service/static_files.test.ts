import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Fallback } from "../../src/listeners/http_front.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import { createStaticFiles } from "../../src/listeners/static_files.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const LOOPBACK = "127.0.0.1";
const LEAKED_CONTENT = "contents-of-a-file-outside-the-root";

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
type Target = { socketPath: string } | { host: string; port: number };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

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
                    body: Buffer.concat(chunks).toString("utf8"),
                }),
            );
        });
        call.end();
    });
}

type Running = { network: Target; socket: Target; env: HermeticEnv };

async function startDaemon(fallback?: Fallback): Promise<Running> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.configDir, "config.toml"), `[network]\naddress = "${LOOPBACK}"\nport = 8080\n`);
    const network = createNetworkListenerComponent({ freePort: true, ...(fallback && { fallback }) });
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: createLogger({ stream: { write: () => true } }),
        sections: [networkSection],
        operations: [],
        components: [createLocalSocketComponent(), network],
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to be ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    const address = network.address();
    assert.ok(address, "the network listener is running");
    return { network: address, socket: { socketPath: localSocketPath(env.runtimeDir) }, env };
}

async function filesIn(env: HermeticEnv): Promise<string> {
    const root = join(env.root, "files");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<p>home</p>");
    await writeFile(join(root, "assets", "app.js"), "export {};");
    await writeFile(join(root, "assets", "style.css"), "a{}");
    await writeFile(join(root, "assets", "logo.svg"), "<svg/>");
    await writeFile(join(root, "assets", "logo.png"), "png");
    await writeFile(join(root, "assets", "data.json"), "{}");
    await writeFile(join(env.root, "secret.txt"), LEAKED_CONTENT);
    await symlink(join(env.root, "secret.txt"), join(root, "linked.txt"));
    return root;
}

describe("static files on the network listener", () => {
    it("redirects GET / to /ui/ on the network listener", async () => {
        const { network } = await startDaemon();

        const answer = await get(network, "/");

        assert.equal(answer.status, 302);
        assert.equal(answer.headers.location, "/ui/");
    });

    it("serves the shipped placeholder page at /ui/ naming The Intern", async () => {
        const { network } = await startDaemon();

        const answer = await get(network, "/ui/");

        assert.equal(answer.status, 200);
        assert.match(String(answer.headers["content-type"]), /^text\/html/);
        assert.match(answer.body, /The Intern/);
    });

    it("serves each file with the content type of its extension", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const root = await filesIn(env);
        const { network } = await startDaemon(createStaticFiles(root));
        const expected: Record<string, RegExp> = {
            "/ui/assets/app.js": /^(text|application)\/javascript/,
            "/ui/assets/style.css": /^text\/css/,
            "/ui/assets/logo.svg": /^image\/svg\+xml/,
            "/ui/assets/logo.png": /^image\/png/,
            "/ui/assets/data.json": /^application\/json/,
            "/ui/": /^text\/html/,
        };

        for (const [path, contentType] of Object.entries(expected)) {
            const answer = await get(network, path);
            assert.equal(answer.status, 200, path);
            assert.match(String(answer.headers["content-type"]), contentType, path);
        }
        assert.equal((await get(network, "/ui/assets/app.js")).body, "export {};");
    });

    it("answers 404 for a missing file and for paths that leave the folder", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const root = await filesIn(env);
        const { network } = await startDaemon(createStaticFiles(root));

        for (const path of [
            "/ui/missing.js",
            "/ui/../secret.txt",
            "/ui/assets/../../secret.txt",
            "/ui/%2e%2e/secret.txt",
            "/ui/..%2fsecret.txt",
            "/ui/linked.txt",
            "/ui/%00",
            "/elsewhere",
        ]) {
            const answer = await get(network, path);
            assert.equal(answer.status, 404, path);
            assert.ok(!answer.body.includes(LEAKED_CONTENT), `${path} leaked the file`);
        }
    });

    it("answers 404 on the local socket for / and /ui/", async () => {
        const { socket } = await startDaemon();

        assert.equal((await get(socket, "/")).status, 404);
        assert.equal((await get(socket, "/ui/")).status, 404);
    });
});
