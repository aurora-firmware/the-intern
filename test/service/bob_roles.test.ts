import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const BOB_ENTRY = join(import.meta.dirname, "..", "..", "src", "cli", "bob.ts");

type Fixture = { env: HermeticEnv; daemon: DaemonProcess };
type RoleView = { name: string; instructions: string; tools: string[]; workspace?: string; model?: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });

async function ownerOnlyFolder(fixture: Fixture, name: string): Promise<string> {
    const path = join(fixture.env.root, name);
    await mkdir(path, { mode: OWNER_ONLY_MODE });
    return path;
}

async function roleNamed(fixture: Fixture, name: string): Promise<RoleView | undefined> {
    const answer = (await fixture.daemon.invoke("roles.list", {})) as { roles: RoleView[] };
    return answer.roles.find((role) => role.name === name);
}

describe("bob roles, workspaces and models", () => {
    it("registers a folder, creates, changes, shows and removes a role on it and unregisters the folder", async () => {
        const fixture = await readyDaemon();
        const folder = await ownerOnlyFolder(fixture, "research-folder");

        const registered = await bob(fixture, ["workspaces", "register", folder]);
        const workspacesAfterRegister = await bob(fixture, ["workspaces", "list"]);
        const created = await bob(fixture, [
            "roles",
            "create",
            "scout",
            "--instructions",
            "Look things up.",
            "--tool",
            "read",
            "--workspace",
            folder,
        ]);
        const rolesAfterCreate = await bob(fixture, ["roles", "list"]);
        const changed = await bob(fixture, ["roles", "change", "scout", "--instructions", "Look harder."]);
        const shown = await bob(fixture, ["roles", "show", "scout"]);
        const shownJson = await bob(fixture, ["roles", "show", "scout", "--json"]);
        const roleBeforeRemoval = await roleNamed(fixture, "scout");
        const removed = await bob(fixture, ["roles", "remove", "scout"]);
        const rolesAfterRemove = await bob(fixture, ["roles", "list"]);
        const unregistered = await bob(fixture, ["workspaces", "unregister", folder]);
        const workspacesAfterUnregister = await bob(fixture, ["workspaces", "list"]);

        for (const result of [registered, created, changed, shown, shownJson, removed, unregistered]) {
            assert.equal(result.status, 0, result.stderr);
        }
        assert.match(workspacesAfterRegister.stdout, new RegExp(folder));
        assert.match(rolesAfterCreate.stdout, /scout/);
        assert.match(shown.stdout, /Look harder\./);
        assert.equal(roleBeforeRemoval?.workspace, folder);
        assert.deepEqual(JSON.parse(shownJson.stdout), roleBeforeRemoval);
        assert.doesNotMatch(rolesAfterRemove.stdout, /scout/);
        assert.doesNotMatch(workspacesAfterUnregister.stdout, new RegExp(folder));
    });

    it("passes the repeatable tool option to roles.create", async () => {
        const fixture = await readyDaemon();

        const created = await bob(fixture, [
            "roles",
            "create",
            "tooled",
            "--instructions",
            "Work.",
            "--tool",
            "read",
            "--tool",
            "bash",
        ]);

        assert.equal(created.status, 0, created.stderr);
        assert.deepEqual((await roleNamed(fixture, "tooled"))?.tools, ["read", "bash"]);
    });

    it("exits 1 with the service's refusal when removing the bob role", async () => {
        const fixture = await readyDaemon();

        const removed = await bob(fixture, ["roles", "remove", "bob"]);

        assert.equal(removed.status, 1);
        assert.match(removed.stderr, /bob/);
        assert.equal(removed.stdout, "");
        assert.ok(await roleNamed(fixture, "bob"));
    });

    it("exits 1 naming the role when roles show names a role the list does not hold", async () => {
        const fixture = await readyDaemon();

        const shown = await bob(fixture, ["roles", "show", "nobody"]);

        assert.equal(shown.status, 1);
        assert.equal(shown.stdout, "");
        assert.match(shown.stderr, /no role named "nobody"/);
    });

    it("prints the models and thinking levels models.list returns, and exactly its answer with --json", async () => {
        const fixture = await readyDaemon();
        const answer = (await fixture.daemon.invoke("models.list", {})) as {
            model: string;
            thinkingLevels: string[];
        }[];

        const text = await bob(fixture, ["models", "list"]);
        const json = await bob(fixture, ["models", "list", "--json"]);

        assert.ok(answer.length > 0);
        assert.equal(text.status, 0, text.stderr);
        const lines = text.stdout.split("\n");
        for (const { model, thinkingLevels } of answer) {
            assert.ok(lines.includes(`${model}  ${thinkingLevels.join(", ")}`), `no line for ${model}`);
        }
        assert.equal(json.status, 0, json.stderr);
        assert.equal(json.stdout, `${JSON.stringify(answer)}\n`);
    });

    it("exits 0 with empty standard error when the reader closes standard output early", async () => {
        const fixture = await readyDaemon();
        const args = [BOB_ENTRY, "models", "list", "--json", "--runtime-dir", fixture.env.runtimeDir];
        const child = spawn(process.execPath, args, { env: fixture.env.env, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.stdout.once("data", () => child.stdout.destroy());

        const status = await new Promise((resolve) => child.on("close", resolve));

        assert.equal(status, 0);
        assert.equal(stderr, "");
    });
});
