/**
 * The client library without a daemon (S-003 REQ-009): the default socket is the daemon's, resolved from the runtime
 * directory, and a call that no daemon answers fails with `UnreachableError` naming where it went (AC-009.2).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createClient, UnreachableError } from "../../src/client/client.ts";
import { defaultSocketPath, nodeTransport } from "../../src/client/node_transport.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const HOME = "/home/team";

const envs: HermeticEnv[] = [];

afterEach(async () => {
    for (const env of envs.splice(0)) await env.dispose();
});

describe("defaultSocketPath", () => {
    it("is bob.sock in the runtime directory under XDG_RUNTIME_DIR", () => {
        const path = defaultSocketPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, homeDir: HOME });
        assert.equal(path, "/run/user/1000/the-intern/bob.sock");
    });

    it("falls back to the runtime directory inside the state directory when XDG_RUNTIME_DIR is unset", () => {
        const path = defaultSocketPath({ env: { XDG_STATE_HOME: "/xdg/state" }, homeDir: HOME });
        assert.equal(path, "/xdg/state/the-intern/run/bob.sock");
    });

    it("uses a runtime directory given as an option, as the daemon's flag does", () => {
        const path = defaultSocketPath({
            env: { XDG_RUNTIME_DIR: "/run/user/1000" },
            homeDir: HOME,
            runtimeDir: "/srv/bob/run",
        });
        assert.equal(path, "/srv/bob/run/bob.sock");
    });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        (value) => assert.fail(`the call was answered with ${JSON.stringify(value)}`),
        (error: unknown) => error,
    );
}

describe("a call no daemon answers", () => {
    it("fails with UnreachableError naming the default socket path when no daemon runs on the instance", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const socketPath = defaultSocketPath({ env: env.env, homeDir: env.root });
        const client = createClient(nodeTransport({ socketPath }));

        const error = await rejection(client.invoke("daemon.status"));

        assert.ok(error instanceof UnreachableError, `the call fails with UnreachableError, not ${error}`);
        assert.equal(error.target, socketPath);
        assert.match(error.message, new RegExp(socketPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
});
