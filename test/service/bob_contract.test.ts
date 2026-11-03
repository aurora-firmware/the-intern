import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createClient } from "../../src/client/client.ts";
import { nodeTransport } from "../../src/client/node_transport.ts";
import { localSocketPath } from "../../src/daemon/state_layout.ts";
import { type BobChild, type BobResult, runBob, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const WAIT_MS = 20_000;
const POLL_MS = 10;
const PAGE_LIMIT = 500;
const OWNER_ONLY_MODE = 0o700;
const ESCAPE = String.fromCharCode(27);
const JUSTIFICATION = "the work is finished";

type JobView = { id: string; number: string; status: string; leadConversation?: string };
type Listing = { id: string; status: string };
type Fixture = { env: HermeticEnv; daemon: DaemonProcess };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const children: BobChild[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        child.signal("SIGKILL");
        await child.exited;
    }
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

const bob = (fixture: Fixture, args: string[], stdin?: string): Promise<BobResult> =>
    runBob(args, {
        runtimeDir: fixture.env.runtimeDir,
        env: fixture.env.env,
        cwd: fixture.env.root,
        ...(stdin !== undefined && { stdin }),
    });

function spawn(fixture: Fixture, args: string[]): BobChild {
    const child = spawnBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });
    children.push(child);
    return child;
}

async function until(isWanted: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await isWanted())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function jsonOf(result: BobResult): unknown {
    assert.equal(result.status, EXIT_OK, result.stderr);
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, `one JSON line expected, got ${result.stdout}`);
    return JSON.parse(lines[0] as string);
}

function assertRefused(result: BobResult): void {
    assert.equal(result.status, EXIT_REFUSED, result.stderr);
    assert.equal(result.stdout, "");
}

async function jobGet(daemon: DaemonProcess, job: string): Promise<JobView> {
    return (await daemon.invoke("jobs.get", { job })) as JobView;
}

// The lead has answered once, so its conversation is idle and its entries no longer change.
async function startedJob(daemon: DaemonProcess): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", { text: "Pick the database" })) as JobView;
    let job = created;
    await until(async () => {
        job = await jobGet(daemon, created.id);
        return job.status === "in_progress" && job.leadConversation !== undefined;
    }, `${created.number} to start`);
    const id = job.leadConversation as string;
    await until(async () => {
        const entries = await daemon.invoke("conversations.entries", { conversationId: id, limit: PAGE_LIMIT });
        return JSON.stringify(entries).includes("pi.assistant");
    }, "the lead's first answer");
    return job;
}

// Completing closes the lead's conversation (S-001 REQ-026), so the test waits for the closed status.
async function completedJob(daemon: DaemonProcess): Promise<JobView> {
    const job = await startedJob(daemon);
    await daemon.invoke("jobs.update", { job: job.id, definitionOfDone: "the database is picked" });
    await daemon.invoke("jobs.complete", { job: job.id, justification: JUSTIFICATION });
    const id = job.leadConversation as string;
    await until(async () => {
        const listings = (await daemon.invoke("conversations.list", {})) as Listing[];
        return listings.find((listing) => listing.id === id)?.status === "closed";
    }, "the lead's conversation to close");
    return jobGet(daemon, job.id);
}

async function ownerOnlyFolder(fixture: Fixture, name: string): Promise<string> {
    const path = join(fixture.env.root, name);
    await mkdir(path, { mode: OWNER_ONLY_MODE });
    return path;
}

describe("bob jobs with --json", () => {
    it("prints the answers of jobs.get, jobs.worklog.list and jobs.history.list for show, and exits 0", async () => {
        const { env, daemon } = await readyDaemon();
        const job = await startedJob(daemon);

        const shown = jsonOf(await bob({ env, daemon }, ["jobs", "show", job.number, "--json"]));

        const page = { job: job.number, limit: PAGE_LIMIT };
        assert.deepEqual(shown, {
            "jobs.get": await jobGet(daemon, job.number),
            "jobs.worklog.list": await daemon.invoke("jobs.worklog.list", page),
            "jobs.history.list": await daemon.invoke("jobs.history.list", page),
        });
    });

    it("prints the job jobs.update answered, which a second jobs.update with the same title answers again, and exits 0", async () => {
        const { env, daemon } = await readyDaemon();
        const job = await startedJob(daemon);

        const updated = jsonOf(await bob({ env, daemon }, ["jobs", "update", job.number, "--title", "New", "--json"]));

        assert.deepEqual(updated, await daemon.invoke("jobs.update", { job: job.number, title: "New" }));
        assert.equal((updated as { title: string }).title, "New");
    });

    it("exits 1 with nothing on standard output for an unknown job, an empty justification and an answer to a Done job", async () => {
        const fixture = await readyDaemon();
        const started = await startedJob(fixture.daemon);
        const done = await completedJob(fixture.daemon);
        assert.equal(done.status, "done");

        const refusals = await Promise.all([
            bob(fixture, ["jobs", "show", "C-999", "--json"]),
            bob(fixture, ["jobs", "complete", started.number, "", "--json"]),
            bob(fixture, ["jobs", "answer", done.number, "one more thing", "--json"]),
        ]);

        for (const result of refusals) assertRefused(result);
        assert.match(refusals[2]?.stderr ?? "", /^conflict: /);
    });
});

describe("bob conversations with --json", () => {
    it("prints the answers of get, entries and invocations for show, and exits 0", async () => {
        const fixture = await readyDaemon();
        const job = await startedJob(fixture.daemon);
        const conversationId = job.leadConversation as string;

        const shown = jsonOf(await bob(fixture, ["conversations", "show", conversationId, "--json"]));

        assert.deepEqual(shown, {
            "conversations.get": await fixture.daemon.invoke("conversations.get", { conversationId }),
            "conversations.entries": await fixture.daemon.invoke("conversations.entries", {
                conversationId,
                limit: PAGE_LIMIT,
            }),
            "conversations.invocations": await fixture.daemon.invoke("conversations.invocations", { conversationId }),
        });
    });

    it("prints the seat conversations.seat answered, and the seat is the one conversations.get reads", async () => {
        const fixture = await readyDaemon();
        const job = await startedJob(fixture.daemon);
        const conversationId = job.leadConversation as string;

        const seated = jsonOf(await bob(fixture, ["conversations", "seat", conversationId, "--role", "gp", "--json"]));

        assert.deepEqual(seated, await fixture.daemon.invoke("conversations.seat", { conversationId, role: "gp" }));
    });

    it("exits 1 with nothing on standard output for an unknown id, an unknown role and a closed conversation", async () => {
        const fixture = await readyDaemon();
        const live = await startedJob(fixture.daemon);
        const done = await completedJob(fixture.daemon);

        const refusals = await Promise.all([
            bob(fixture, ["conversations", "show", "999999", "--json"]),
            bob(fixture, [
                "conversations",
                "seat",
                live.leadConversation as string,
                "--role",
                "no-such-role",
                "--json",
            ]),
            bob(fixture, ["conversations", "send", done.leadConversation as string, "hello", "--json"]),
        ]);

        for (const result of refusals) assertRefused(result);
        assert.match(refusals[2]?.stderr ?? "", /^conflict: /);
    });
});

describe("bob roles, workspaces and models with --json", () => {
    it("prints the answers of roles.list, workspaces.list and models.list, and exits 0", async () => {
        const fixture = await readyDaemon();

        const roles = jsonOf(await bob(fixture, ["roles", "list", "--json"]));
        const workspaces = jsonOf(await bob(fixture, ["workspaces", "list", "--json"]));
        const models = jsonOf(await bob(fixture, ["models", "list", "--json"]));

        assert.deepEqual(roles, await fixture.daemon.invoke("roles.list", {}));
        assert.deepEqual(workspaces, await fixture.daemon.invoke("workspaces.list", {}));
        assert.deepEqual(models, await fixture.daemon.invoke("models.list", {}));
    });

    it("prints the role roles.create answered, which roles.list then holds, and exits 0", async () => {
        const fixture = await readyDaemon();

        const created = jsonOf(
            await bob(fixture, ["roles", "create", "scout", "--instructions", "Look things up.", "--json"]),
        );

        const listed = (await fixture.daemon.invoke("roles.list", {})) as { roles: { name: string }[] };
        const role = listed.roles.find((candidate) => candidate.name === "scout");
        assert.ok(role, "roles.list holds the new role");
        assert.deepEqual(created, await fixture.daemon.invoke("roles.change", { name: "scout" }));
    });

    it("prints the answer workspaces.register gave for an owner-only folder, and exits 0", async () => {
        const fixture = await readyDaemon();
        const folder = await ownerOnlyFolder(fixture, "research-folder");

        const registered = jsonOf(await bob(fixture, ["workspaces", "register", folder, "--json"]));

        assert.deepEqual(registered, await fixture.daemon.invoke("workspaces.register", { path: folder }));
    });

    it("exits 1 with nothing on standard output for removing bob and registering a path that does not exist", async () => {
        const fixture = await readyDaemon();

        const refusals = await Promise.all([
            bob(fixture, ["roles", "remove", "bob", "--json"]),
            bob(fixture, ["workspaces", "register", join(fixture.env.root, "missing"), "--json"]),
        ]);

        for (const result of refusals) assertRefused(result);
    });
});

describe("bob status, usage and export with --json", () => {
    it("prints the answers of daemon.status and usage.get, and exits 0", async () => {
        const fixture = await readyDaemon();

        const status = jsonOf(await bob(fixture, ["status", "--json"]));
        const usage = jsonOf(await bob(fixture, ["usage", "--json"]));

        assert.deepEqual(status, await fixture.daemon.invoke("daemon.status", {}));
        assert.deepEqual(usage, await fixture.daemon.invoke("usage.get", {}));
    });

    it("prints the path and size of the file jobs.export wrote, and refuses a file that exists", async () => {
        const fixture = await readyDaemon();

        const exported = jsonOf(await bob(fixture, ["export", "backup.db", "--json"]));
        const again = await bob(fixture, ["export", "backup.db", "--json"]);

        const file = join(fixture.env.root, "backup.db");
        assert.deepEqual(exported, { path: file, size: (await stat(file)).size });
        assertRefused(again);
    });
});

describe("bob following commands with --json", () => {
    it("prints the answer of jobs.get as the first line of jobs follow on a Done job, and exits 0", async () => {
        const fixture = await readyDaemon();
        const done = await completedJob(fixture.daemon);

        const result = await bob(fixture, ["jobs", "follow", done.number, "--json"]);

        assert.deepEqual(jsonOf(result), await jobGet(fixture.daemon, done.number));
    });

    it("exits 1 with nothing on standard output when jobs follow gets an unknown job", async () => {
        const fixture = await readyDaemon();

        assertRefused(await bob(fixture, ["jobs", "follow", "C-999", "--json"]));
    });

    it("prints the instance feed snapshot as the first line of follow on a quiet daemon, and exits 0 on SIGINT", async () => {
        const fixture = await readyDaemon();
        const client = createClient(nodeTransport({ socketPath: localSocketPath(fixture.env.runtimeDir) }));
        const subscription = client.subscribe({ scope: "instance" });
        const first = await subscription.next();
        await subscription.return({ end: "closed" });
        assert.ok(!first.done && "snapshot" in first.value, "the feed opens with a snapshot");

        const child = spawn(fixture, ["follow", "--json"]);
        await child.waitFor("stdout", "\n");
        child.signal("SIGINT");

        assert.equal(await child.exited, EXIT_OK, child.stderr());
        assert.deepEqual(
            JSON.parse(child.stdout().split("\n")[0] as string),
            (first.value as { snapshot: unknown }).snapshot,
        );
    });

    it("prints each entries answer of the front desk as one line of chat --json, as the service gives it", async () => {
        const fixture = await readyDaemon();

        const result = await bob(fixture, ["chat", "--json"], "hello\n");

        const lines = result.stdout.split("\n").filter((line) => line !== "");
        assert.equal(result.status, EXIT_OK, result.stderr);
        assert.equal(lines.length, 1);
        const { conversationId } = (await fixture.daemon.invoke("desk.get", {})) as { conversationId: string };
        const entries = await fixture.daemon.invoke("conversations.entries", { conversationId, limit: PAGE_LIMIT });
        assert.deepEqual(JSON.parse(lines[0] as string), entries);
    });
});

describe("bob output without a terminal", () => {
    it("prints the text of jobs list with no terminal control sequence when standard output is piped", async () => {
        const fixture = await readyDaemon();
        const job = await startedJob(fixture.daemon);

        const result = await bob(fixture, ["jobs", "list"]);

        assert.equal(result.status, EXIT_OK, result.stderr);
        assert.ok(result.stdout.includes(job.number), result.stdout);
        assert.ok(!result.stdout.includes(ESCAPE), "no escape character in the piped text");
    });
});
