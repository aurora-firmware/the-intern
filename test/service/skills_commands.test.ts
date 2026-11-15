import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { roleInstructionPath } from "../../src/skills/internal_folder.ts";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const CODE_REVIEW = "code-review";
const SHIPPED = "carry-out-a-part";

type Fixture = { env: HermeticEnv; daemon: DaemonProcess; conversation: string };
type SkillView = { name: string; path: string; enabled: boolean };

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
    const folder = join(env.dataDir, "skills", CODE_REVIEW);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${CODE_REVIEW}\ndescription: Review code.\n---\nBody.\n`);
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    const listed = (await daemon.invoke("conversations.list", {})) as { id: string; isFrontDesk: boolean }[];
    const desk = listed.find((listing) => listing.isFrontDesk);
    assert.ok(desk, "the front desk conversation exists");
    return { env, daemon, conversation: desk.id };
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });

describe("bob skills commands", () => {
    it("enables a skill for a conversation, lists it enabled with its path, and restores a shipped skill, each exiting 0", async () => {
        const fixture = await readyDaemon();
        const { conversation } = fixture;

        const enabled = await bob(fixture, ["skills", "enable", CODE_REVIEW, "--conversation", conversation]);
        const listed = await bob(fixture, ["skills", "list", "--conversation", conversation]);
        const restored = await bob(fixture, ["skills", "restore", SHIPPED]);

        assert.equal(enabled.status, 0, enabled.stderr);
        assert.equal(listed.status, 0, listed.stderr);
        assert.equal(restored.status, 0, restored.stderr);
        const line = listed.stdout.split("\n").find((candidate) => candidate.startsWith(`${CODE_REVIEW}  `));
        assert.ok(line, listed.stdout);
        assert.ok(line.includes(join(fixture.env.dataDir, "skills", CODE_REVIEW)), line);
        assert.ok(line.includes("enabled"), line);
        assert.ok(restored.stdout.startsWith(`${SHIPPED}  `), restored.stdout);
    });

    it("prints what the operation returned with --json", async () => {
        const fixture = await readyDaemon();
        const { conversation } = fixture;

        const enabled = await bob(fixture, ["skills", "enable", CODE_REVIEW, "--conversation", conversation, "--json"]);
        const listed = await bob(fixture, ["skills", "list", "--conversation", conversation, "--json"]);
        const restored = await bob(fixture, ["skills", "restore", SHIPPED, "--json"]);

        const enabledAnswer = JSON.parse(enabled.stdout) as { enabledSkills: string[] };
        assert.ok(enabledAnswer.enabledSkills.includes(CODE_REVIEW));
        const listAnswer = JSON.parse(listed.stdout) as { skills: SkillView[] };
        assert.deepEqual(listAnswer, await fixture.daemon.invoke("skills.list", { conversation }));
        assert.equal(listAnswer.skills.find((skill) => skill.name === CODE_REVIEW)?.enabled, true);
        assert.equal((JSON.parse(restored.stdout) as SkillView).name, SHIPPED);
    });

    it("disables a skill for a role and lists the search paths", async () => {
        const fixture = await readyDaemon();

        const disabled = await bob(fixture, ["skills", "disable", SHIPPED, "--role", "gp"]);
        const paths = await bob(fixture, ["skills", "paths", "--json"]);

        assert.equal(disabled.status, 0, disabled.stderr);
        assert.equal(paths.status, 0, paths.stderr);
        assert.deepEqual(JSON.parse(paths.stdout), await fixture.daemon.invoke("skills.paths.list", {}));
    });

    it("adds and removes a search path", async () => {
        const fixture = await readyDaemon();
        const extra = join(fixture.env.dataDir, "extra-skills");
        await mkdir(extra, { recursive: true, mode: 0o700 });

        const added = await bob(fixture, ["skills", "add-path", extra]);
        const removed = await bob(fixture, ["skills", "remove-path", extra]);

        assert.equal(added.status, 0, added.stderr);
        assert.ok(added.stdout.includes(extra), added.stdout);
        assert.equal(removed.status, 0, removed.stderr);
        assert.ok(!removed.stdout.includes(extra), removed.stdout);
    });
});

describe("bob instructions commands", () => {
    it("lists the common prompt and bob.md, marking bob.md edited after an edit, and exits 0 (AC-003.1)", async () => {
        const fixture = await readyDaemon();
        await appendFile(roleInstructionPath(fixture.env.dataDir, "bob"), "\nAlso be brief.\n");

        const listed = await bob(fixture, ["instructions", "list", "--role", "bob"]);

        assert.equal(listed.status, 0, listed.stderr);
        const lines = listed.stdout.split("\n");
        assert.ok(lines[0]?.startsWith("common  "), listed.stdout);
        const roleLine = lines.find((line) => line.startsWith("role  "));
        assert.ok(roleLine?.includes("bob.md"), listed.stdout);
        assert.ok(roleLine?.includes("edited"), roleLine);
        assert.ok(!listed.stdout.includes("Also be brief"), "no command prints file text");
    });

    it("prints what the operation returned with --json", async () => {
        const fixture = await readyDaemon();
        const { conversation } = fixture;

        const byRole = await bob(fixture, ["instructions", "list", "--role", "bob", "--json"]);
        const byConversation = await bob(fixture, ["instructions", "list", "--conversation", conversation, "--json"]);

        assert.deepEqual(JSON.parse(byRole.stdout), await fixture.daemon.invoke("instructions.list", { role: "bob" }));
        assert.deepEqual(
            JSON.parse(byConversation.stdout),
            await fixture.daemon.invoke("instructions.list", { conversation }),
        );
    });

    it("restores the common prompt and a shipped role, each exiting 0", async () => {
        const fixture = await readyDaemon();
        await appendFile(roleInstructionPath(fixture.env.dataDir, "bob"), "\nAlso be brief.\n");

        const common = await bob(fixture, ["instructions", "restore", "common"]);
        const role = await bob(fixture, ["instructions", "restore", "bob", "--json"]);

        assert.equal(common.status, 0, common.stderr);
        assert.ok(common.stdout.startsWith("common  "), common.stdout);
        assert.equal(role.status, 0, role.stderr);
        assert.equal((JSON.parse(role.stdout) as { edited: boolean }).edited, false);
    });

    it("refuses to restore a team role and exits 1 (AC-003.3)", async () => {
        const fixture = await readyDaemon();

        const refused = await bob(fixture, ["instructions", "restore", "reviewer"]);

        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /neither the common prompt nor a shipped role/);
    });
});
