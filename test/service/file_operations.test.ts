/**
 * The files operations (S-008 REQ-010): `files.read` and `files.write` reach only the instruction files, the skill
 * folders the catalog found, a workspace's `.pi/skills` and the context files of a workspace and its parent folders,
 * follow the symbolic links on the way, and a write is guarded by the version the read returned. The operating system's
 * permissions decide what a link may reach.
 */
import assert from "node:assert/strict";
import {
    chmod,
    chown,
    cp,
    lstat,
    mkdir,
    readdir,
    readFile,
    readlink,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Caller } from "../../src/service/operations.ts";
import type { FileChange } from "../../src/skills/file_store.ts";
import { DEFAULT_SHIPPED_ROOT } from "../../src/skills/internal_folder.ts";
import { createSkillsComponent } from "../../src/skills/skills_component.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const ONE_MIB = 1024 * 1024;
const TEAM_MEMBER: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

type Fixture = {
    env: HermeticEnv;
    workspace: string;
    announced: FileChange[];
    read(path: string): Promise<{ text: string; version: string }>;
    write(path: string, text: string, version: string): Promise<unknown>;
};

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const shippedRoot = join(env.root, "shipped");
    await cp(DEFAULT_SHIPPED_ROOT, shippedRoot, { recursive: true });
    const workspace = join(env.root, "workspace");
    await mkdir(workspace);
    const logger = createLogger({ verbose: false, stream: { write: () => true } });
    const announced: FileChange[] = [];
    const skills = createSkillsComponent({ logger, shippedRoot });
    // No agents component runs here, so a stub stands in for the role catalog and the workspaces `workspaces.list()` names.
    skills.connectAgents(
        () =>
            ({
                catalog: { get: () => undefined, list: () => [] },
                workspaces: { list: () => [{ path: workspace, kind: "registered" }] },
            }) as never,
    );
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: skills.sections,
        components: [
            skills.component,
            {
                name: "announcements",
                checkModels: async (ctx) => void ctx.fileChanges.onChange((change) => announced.push(change)),
            },
        ],
        operations: skills.operations,
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready") {
        if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to be ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return {
        env,
        workspace,
        announced,
        read: async (path) =>
            (await daemon.catalogue.invoke("files.read", { path }, TEAM_MEMBER)) as { text: string; version: string },
        write: (path, text, version) => daemon.catalogue.invoke("files.write", { path, text, version }, TEAM_MEMBER),
    };
}

async function chownGroup(path: string, gid: number): Promise<void> {
    await chown(path, -1, gid);
}

const refusal = (code: string) => (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === code;

describe("files.read", () => {
    it("returns the text and a version of the common prompt", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.dataDir, "instructions/common.md");

        const read = await fixture.read(path);

        assert.equal(read.text, await readFile(path, "utf8"));
        assert.match(read.version, /^[0-9a-f]{64}$/);
    });

    it("reads a skill file and a workspace's AGENTS.md, CLAUDE.md and .pi/skills file", async () => {
        const fixture = await createFixture();
        const skill = join(fixture.env.dataDir, "skills/carry-out-a-part/SKILL.md");
        await writeFile(join(fixture.workspace, "AGENTS.md"), "agents\n");
        await writeFile(join(fixture.workspace, "CLAUDE.md"), "claude\n");
        await mkdir(join(fixture.workspace, ".pi/skills/local"), { recursive: true });
        await writeFile(join(fixture.workspace, ".pi/skills/local/SKILL.md"), "local\n");

        assert.equal((await fixture.read(skill)).text, await readFile(skill, "utf8"));
        assert.equal((await fixture.read(join(fixture.workspace, "AGENTS.md"))).text, "agents\n");
        assert.equal((await fixture.read(join(fixture.workspace, "CLAUDE.md"))).text, "claude\n");
        assert.equal((await fixture.read(join(fixture.workspace, ".pi/skills/local/SKILL.md"))).text, "local\n");
    });

    it("refuses /etc/passwd, config.toml and another workspace file as invalid input", async () => {
        const fixture = await createFixture();
        await writeFile(join(fixture.workspace, "notes.md"), "notes\n");

        for (const path of [
            "/etc/passwd",
            join(fixture.env.configDir, "config.toml"),
            join(fixture.workspace, "notes.md"),
        ]) {
            await assert.rejects(fixture.read(path), refusal("invalid_input"), path);
        }
    });

    it("refuses a relative path as invalid input", async () => {
        const fixture = await createFixture();

        await assert.rejects(fixture.read("instructions/common.md"), refusal("invalid_input"));
    });

    it("refuses a path that climbs out of the instructions folder", async () => {
        const fixture = await createFixture();

        await assert.rejects(
            fixture.read(join(fixture.env.dataDir, "instructions/../shipped-files.json")),
            refusal("invalid_input"),
        );
    });

    it("refuses a missing skill file as not found", async () => {
        const fixture = await createFixture();

        await assert.rejects(
            fixture.read(join(fixture.env.dataDir, "skills/carry-out-a-part/missing.md")),
            refusal("not_found"),
        );
    });

    it("refuses a missing file under a missing folder inside an allowed one as not found", async () => {
        const fixture = await createFixture();

        await assert.rejects(
            fixture.read(join(fixture.env.dataDir, "skills/carry-out-a-part/no/such/file.md")),
            refusal("not_found"),
        );
    });

    it("refuses a folder, a file over 1 MiB and text that isn't UTF-8 as invalid input", async () => {
        const fixture = await createFixture();
        const folder = join(fixture.env.dataDir, "skills/carry-out-a-part");
        await writeFile(join(folder, "big.md"), "x".repeat(ONE_MIB + 1));
        await writeFile(join(folder, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00]));

        for (const path of [folder, join(folder, "big.md"), join(folder, "binary.bin")]) {
            await assert.rejects(fixture.read(path), refusal("invalid_input"), path);
        }
    });

    it("reads the real file of an AGENTS.md that is a symbolic link, as the prompt does", async () => {
        const fixture = await createFixture();
        const target = join(fixture.env.root, "shared-agents.md");
        await writeFile(target, "shared\n");
        await symlink(target, join(fixture.workspace, "AGENTS.md"));

        assert.equal((await fixture.read(join(fixture.workspace, "AGENTS.md"))).text, "shared\n");
    });

    it("refuses notes.md for its name, though it is a symbolic link to a readable file", async () => {
        const fixture = await createFixture();
        const target = join(fixture.env.root, "shared-notes.md");
        await writeFile(target, "notes\n");
        await symlink(target, join(fixture.workspace, "notes.md"));

        await assert.rejects(fixture.read(join(fixture.workspace, "notes.md")), refusal("invalid_input"));
    });

    it("reads a skill file that is a symbolic link to a readable file outside the skill folder", async () => {
        const fixture = await createFixture();
        const target = join(fixture.env.root, "outside.md");
        await writeFile(target, "outside\n");
        const link = join(fixture.env.dataDir, "skills/carry-out-a-part/linked.md");
        await symlink(target, link);

        const read = await fixture.read(link);

        assert.equal(read.text, "outside\n");
        assert.match(read.version, /^[0-9a-f]{64}$/);
    });

    it("reads an AGENTS.md beside an AGENTS.override.md that pi agent doesn't read", async () => {
        const fixture = await createFixture();
        await writeFile(join(fixture.workspace, "AGENTS.override.md"), "override\n");
        await writeFile(join(fixture.workspace, "AGENTS.md"), "agents\n");

        assert.equal((await fixture.read(join(fixture.workspace, "AGENTS.override.md"))).text, "override\n");
        assert.equal((await fixture.read(join(fixture.workspace, "AGENTS.md"))).text, "agents\n");
    });

    it("reads each of the five context file names in a parent folder of the workspace", async () => {
        const fixture = await createFixture();
        const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
        await Promise.all(names.map((name) => writeFile(join(fixture.env.root, name), `${name}\n`)));

        for (const name of names) {
            assert.equal((await fixture.read(join(fixture.env.root, name))).text, `${name}\n`, name);
        }
    });

    it("refuses a skill file that is a link to a missing target as not found", async () => {
        const fixture = await createFixture();
        const link = join(fixture.env.dataDir, "skills/carry-out-a-part/dangling.md");
        await symlink(join(fixture.env.root, "nowhere.md"), link);

        await assert.rejects(fixture.read(link), refusal("not_found"));
    });

    it("refuses a link whose target the system won't let the service account read, naming the reason", {
        skip: process.getuid?.() === 0,
    }, async () => {
        const fixture = await createFixture();
        const target = join(fixture.env.root, "locked.md");
        await writeFile(target, "locked\n");
        await chmod(target, 0o000);
        const link = join(fixture.workspace, "AGENTS.md");
        await symlink(target, link);

        await assert.rejects(fixture.read(link), (error: unknown) => {
            const message = (error as Error).message;
            return refusal("invalid_input")(error) && message.includes(link) && message.includes("permission denied");
        });
    });

    it("refuses a cycle of links as invalid input, naming the path", async () => {
        const fixture = await createFixture();
        const first = join(fixture.workspace, "AGENTS.md");
        const second = join(fixture.workspace, "loop.md");
        await symlink(second, first);
        await symlink(first, second);

        await assert.rejects(fixture.read(first), (error: unknown) => {
            return refusal("invalid_input")(error) && (error as Error).message.includes(first);
        });
    });
});

describe("files.write", () => {
    it("saves the text, returns the file's new version and reads back what was written", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.dataDir, "instructions/common.md");
        const { version } = await fixture.read(path);

        const written = (await fixture.write(path, "new text\n", version)) as { version: string };

        assert.equal(await readFile(path, "utf8"), "new text\n");
        assert.equal((await fixture.read(path)).version, written.version);
        assert.notEqual(written.version, version);
    });

    it("refuses conflict after a hand edit of a file that was read, and keeps the hand edit", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.dataDir, "instructions/common.md");
        const { version } = await fixture.read(path);
        await writeFile(path, "edited by hand\n");

        await assert.rejects(fixture.write(path, "from the page\n", version), refusal("conflict"));

        assert.equal(await readFile(path, "utf8"), "edited by hand\n");
    });

    it("sends one files_changed delta naming the role file and kind role, and a hand edit sends none", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.dataDir, "instructions/roles/gp.md");
        const { version } = await fixture.read(path);
        await writeFile(path, "hand edit\n");
        assert.deepEqual(fixture.announced, []);
        const edited = await fixture.read(path);

        await fixture.write(path, "saved\n", edited.version);

        assert.notEqual(edited.version, version);
        assert.deepEqual(fixture.announced, [{ path, kind: "role" }]);
    });

    it("announces the kind of each file: common, instructions, workspace and skill", async () => {
        const fixture = await createFixture();
        const common = join(fixture.env.dataDir, "instructions/common.md");
        const other = join(fixture.env.dataDir, "instructions/notes.md");
        const agents = join(fixture.workspace, "AGENTS.md");
        const skill = join(fixture.env.dataDir, "skills/carry-out-a-part/SKILL.md");
        await writeFile(other, "notes\n");
        await writeFile(agents, "agents\n");

        for (const path of [common, other, agents, skill]) {
            await fixture.write(path, "saved\n", (await fixture.read(path)).version);
        }

        assert.deepEqual(fixture.announced, [
            { path: common, kind: "common" },
            { path: other, kind: "instructions" },
            { path: agents, kind: "workspace" },
            { path: skill, kind: "skill" },
        ]);
    });

    it("saves through an AGENTS.md link, keeping the link, the target's mode and its group", async () => {
        const fixture = await createFixture();
        const target = join(fixture.env.root, "shared-agents.md");
        await writeFile(target, "shared\n");
        await chmod(target, 0o640);
        const otherGroup = process.getgroups?.().find((group) => group !== process.getgid?.());
        if (otherGroup !== undefined) await chownGroup(target, otherGroup);
        const link = join(fixture.workspace, "AGENTS.md");
        await symlink(target, link);
        const { version } = await fixture.read(link);

        await fixture.write(link, "saved\n", version);

        assert.equal((await lstat(link)).isSymbolicLink(), true);
        assert.equal(await readlink(link), target);
        assert.equal(await readFile(target, "utf8"), "saved\n");
        const info = await stat(target);
        assert.equal(info.mode & 0o7777, 0o640);
        if (otherGroup !== undefined) assert.equal(info.gid, otherGroup);
        assert.deepEqual(fixture.announced, [{ path: link, kind: "workspace" }]);
    });

    it("saves an AGENTS.md in a parent folder of the workspace and announces kind workspace", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.root, "AGENTS.md");
        await writeFile(path, "parent\n");

        await fixture.write(path, "saved\n", (await fixture.read(path)).version);

        assert.equal(await readFile(path, "utf8"), "saved\n");
        assert.deepEqual(fixture.announced, [{ path, kind: "workspace" }]);
    });

    it("saves an AGENTS.md written with a dot segment and announces the normalised path", async () => {
        const fixture = await createFixture();
        const path = join(fixture.workspace, "AGENTS.md");
        await writeFile(path, "agents\n");
        const given = `${fixture.workspace}/./sub/../AGENTS.md`;

        await fixture.write(given, "saved\n", (await fixture.read(given)).version);

        assert.deepEqual(fixture.announced, [{ path, kind: "workspace" }]);
    });

    it("refuses a save when the system won't let the service account write the folder, naming the reason", {
        skip: process.getuid?.() === 0,
    }, async () => {
        const fixture = await createFixture();
        const folder = join(fixture.env.root, "locked-folder");
        await mkdir(folder);
        const target = join(folder, "AGENTS.md");
        await writeFile(target, "text\n");
        const link = join(fixture.workspace, "AGENTS.md");
        await symlink(target, link);
        const { version } = await fixture.read(link);
        await chmod(folder, 0o500);
        try {
            await assert.rejects(fixture.write(link, "saved\n", version), (error: unknown) => {
                const message = (error as Error).message;
                return (
                    refusal("invalid_input")(error) && message.includes(link) && message.includes("permission denied")
                );
            });
        } finally {
            await chmod(folder, 0o700);
        }
        assert.equal(await readFile(target, "utf8"), "text\n");
    });

    it("refuses a file that doesn't exist as not found and creates nothing", async () => {
        const fixture = await createFixture();
        const folder = join(fixture.env.dataDir, "instructions/roles");
        const before = await readdir(folder);

        await assert.rejects(fixture.write(join(folder, "nobody.md"), "text\n", "0".repeat(64)), refusal("not_found"));

        assert.deepEqual(await readdir(folder), before);
        assert.deepEqual(fixture.announced, []);
    });

    it("refuses a path outside the allowed files as invalid input and writes nothing", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.configDir, "config.toml");

        await assert.rejects(fixture.write(path, "x\n", "0".repeat(64)), refusal("invalid_input"));

        await assert.rejects(readFile(path), { code: "ENOENT" });
    });

    it("refuses text over 1 MiB as invalid input and keeps the file", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.dataDir, "instructions/common.md");
        const { text, version } = await fixture.read(path);

        await assert.rejects(fixture.write(path, "x".repeat(ONE_MIB + 1), version), refusal("invalid_input"));

        assert.equal(await readFile(path, "utf8"), text);
    });

    it("refuses a folder as invalid input", async () => {
        const fixture = await createFixture();

        await assert.rejects(
            fixture.write(join(fixture.env.dataDir, "skills/carry-out-a-part"), "x\n", "0".repeat(64)),
            refusal("invalid_input"),
        );
    });

    it("refuses input without a version", async () => {
        const fixture = await createFixture();
        const path = join(fixture.env.dataDir, "instructions/common.md");

        await assert.rejects(fixture.write(path, "x\n", undefined as never), refusal("invalid_input"));
    });
});
