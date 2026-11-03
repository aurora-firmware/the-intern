import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const INVOKED_COUNT = 3;

type JobView = { id: string; status: string; leadConversation?: string };
type Tree = { id: string; role: string | null; status: string; invoked: Tree[] };
type Fixture = { env: HermeticEnv; daemon: DaemonProcess; leadId: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function until(isWanted: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await isWanted())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function countInvoked(tree: Tree): number {
    return tree.invoked.reduce((sum, child) => sum + 1 + countInvoked(child), 0);
}

const invocationsOf = (daemon: DaemonProcess, conversationId: string) =>
    daemon.invoke("conversations.invocations", { conversationId }) as Promise<Tree>;

async function nestedFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "invoke-nested", turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    const created = (await daemon.invoke("jobs.create", { text: "Pick the database" })) as JobView;
    let leadId = "";
    await until(async () => {
        const job = (await daemon.invoke("jobs.get", { job: created.id })) as JobView;
        leadId = job.leadConversation ?? "";
        return leadId !== "" && countInvoked(await invocationsOf(daemon, leadId)) === INVOKED_COUNT;
    }, "the lead and its three invoked conversations");
    return { env, daemon, leadId };
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });

describe("bob conversations show on invoked conversations", () => {
    it("gives the lead two invoked conversations and the first of them one of its own under the invoke-nested script", async () => {
        const { daemon, leadId } = await nestedFixture();
        const tree = await invocationsOf(daemon, leadId);
        assert.deepEqual(tree.invoked.map((child) => child.invoked.length).sort(), [0, 1]);
    });

    it("lists each invoked conversation under its invoker, indented by depth", async () => {
        const fixture = await nestedFixture();
        const tree = await invocationsOf(fixture.daemon, fixture.leadId);
        const result = await bob(fixture, ["conversations", "show", fixture.leadId]);
        assert.equal(result.status, 0, result.stderr);
        const section = result.stdout.slice(result.stdout.indexOf("Invoked conversations:")).split("\n");
        const line = (node: Tree, depth: number) => `${"  ".repeat(depth + 1)}${node.id}  ${node.role}  ${node.status}`;
        const expected = [
            line(tree, 0),
            ...tree.invoked.flatMap((child) => [
                line(child, 1),
                ...child.invoked.map((grandchild) => line(grandchild, 2)),
            ]),
        ];
        assert.deepEqual(section.slice(1, 1 + expected.length), expected);
    });

    it("prints the answer of conversations.invocations unchanged with --json", async () => {
        const fixture = await nestedFixture();
        const result = await bob(fixture, ["conversations", "show", fixture.leadId, "--json"]);
        assert.equal(result.status, 0, result.stderr);
        const printed = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.deepEqual(printed["conversations.invocations"], await invocationsOf(fixture.daemon, fixture.leadId));
    });
});
