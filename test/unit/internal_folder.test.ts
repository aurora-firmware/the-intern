import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFileStore } from "../../src/skills/file_store.ts";
import {
    commonPromptPath,
    DEFAULT_SHIPPED_ROOT,
    InternalFolderError,
    instructionsFolderPath,
    manifestPath,
    prepareInternalFolder,
    readManifest,
    roleInstructionPath,
    shippedFileStates,
    skillsFolderPath,
} from "../../src/skills/internal_folder.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const COMMON = "instructions/common.md";
const ROLE = "instructions/roles/gp.md";
const SKILL = "skills/alpha/SKILL.md";
const SKILL_EXTRA = "skills/alpha/notes/more.md";

async function putFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [relative, text] of Object.entries(files)) {
        await mkdir(dirname(join(root, relative)), { recursive: true });
        await writeFile(join(root, relative), text);
    }
}

async function listTree(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const lines = await Promise.all(
        entries.map(async (entry) => {
            const path = join(entry.parentPath, entry.name);
            return entry.isDirectory() ? `${path}/` : `${path}=${await readFile(path, "utf8")}`;
        }),
    );
    return lines.sort();
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe("the internal folder", () => {
    let base: string;
    let shippedRoot: string;
    let dataDir: string;
    const prepare = () => prepareInternalFolder({ dataDir, shippedRoot, store: createFileStore() });
    const readText = (relative: string) => readFile(join(dataDir, relative), "utf8");

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), "internal-folder-"));
        shippedRoot = join(base, "shipped");
        dataDir = join(base, "data");
        await putFiles(shippedRoot, { [COMMON]: "common 1", [ROLE]: "role 1", [SKILL]: "skill 1" });
    });

    afterEach(async () => {
        await chmod(shippedRoot, 0o700).catch(() => undefined);
        await rm(base, { recursive: true, force: true });
    });

    describe("paths", () => {
        it("names the folders and files under the data directory", () => {
            assert.equal(instructionsFolderPath("/d"), "/d/instructions");
            assert.equal(commonPromptPath("/d"), "/d/instructions/common.md");
            assert.equal(roleInstructionPath("/d", "gp"), "/d/instructions/roles/gp.md");
            assert.equal(skillsFolderPath("/d"), "/d/skills");
            assert.equal(manifestPath("/d"), "/d/shipped-files.json");
        });

        it("points the default shipped root at the package's src/shipped folder", async () => {
            assert.ok(DEFAULT_SHIPPED_ROOT.endsWith("/src/shipped"));
            assert.ok((await stat(join(DEFAULT_SHIPPED_ROOT, COMMON))).isFile());
        });
    });

    describe("readManifest", () => {
        it("reads an absent file as empty", async () => {
            assert.deepEqual(await readManifest(dataDir), { version: 1, files: {} });
        });

        it("refuses a manifest that is not valid, naming its path", async () => {
            await mkdir(dataDir, { recursive: true });
            await writeFile(manifestPath(dataDir), "{not json");
            await assert.rejects(
                readManifest(dataDir),
                (error) => error instanceof InternalFolderError && error.path === manifestPath(dataDir),
            );
        });
    });

    describe("the first start", () => {
        it("copies every shipped file and records each hash", async () => {
            await prepare();
            assert.equal(await readText(COMMON), "common 1");
            assert.equal(await readText(ROLE), "role 1");
            assert.equal(await readText(SKILL), "skill 1");
            assert.deepEqual(await readManifest(dataDir), {
                version: 1,
                files: { [COMMON]: sha256("common 1"), [ROLE]: sha256("role 1"), [SKILL]: sha256("skill 1") },
            });
        });

        it("creates folders 0700 and files 0600, the manifest included", async () => {
            await prepare();
            for (const folder of [
                instructionsFolderPath(dataDir),
                join(dataDir, "instructions/roles"),
                skillsFolderPath(dataDir),
                join(dataDir, "skills/alpha"),
            ]) {
                assert.equal(await modeOf(folder), 0o700, folder);
            }
            for (const file of [join(dataDir, COMMON), join(dataDir, SKILL), manifestPath(dataDir)]) {
                assert.equal(await modeOf(file), 0o600, file);
            }
        });

        it("creates the folders even when nothing is shipped", async () => {
            await rm(shippedRoot, { recursive: true });
            await mkdir(shippedRoot);
            await prepare();
            assert.ok((await stat(skillsFolderPath(dataDir))).isDirectory());
            assert.ok((await stat(join(dataDir, "instructions/roles"))).isDirectory());
        });

        it("changes nothing on a second start", async () => {
            await prepare();
            const before = await listTree(dataDir);
            await prepare();
            assert.deepEqual(await listTree(dataDir), before);
        });
    });

    describe("new shipped bytes", () => {
        beforeEach(prepare);

        it("replaces an unedited file and takes the new hash", async () => {
            await putFiles(shippedRoot, { [COMMON]: "common 2" });
            await prepare();
            assert.equal(await readText(COMMON), "common 2");
            assert.equal((await readManifest(dataDir)).files[COMMON], sha256("common 2"));
        });

        it("leaves an edited file and keeps its recorded hash", async () => {
            await writeFile(join(dataDir, COMMON), "mine");
            await putFiles(shippedRoot, { [COMMON]: "common 2" });
            await prepare();
            assert.equal(await readText(COMMON), "mine");
            assert.equal((await readManifest(dataDir)).files[COMMON], sha256("common 1"));
        });

        it("leaves a deleted file deleted and keeps its recorded hash", async () => {
            await rm(join(dataDir, ROLE));
            await putFiles(shippedRoot, { [ROLE]: "role 2" });
            await prepare();
            await assert.rejects(readText(ROLE), { code: "ENOENT" });
            assert.equal((await readManifest(dataDir)).files[ROLE], sha256("role 1"));
        });

        it("takes the new hash for an edited file that already equals the new bytes", async () => {
            await writeFile(join(dataDir, COMMON), "common 2");
            await putFiles(shippedRoot, { [COMMON]: "common 2" });
            await prepare();
            assert.equal((await readManifest(dataDir)).files[COMMON], sha256("common 2"));
            const states = await shippedFileStates({ dataDir, shippedRoot });
            assert.deepEqual(states[COMMON], { edited: false, missing: false });
        });

        it("copies a newly shipped file", async () => {
            await putFiles(shippedRoot, { [SKILL_EXTRA]: "extra" });
            await prepare();
            assert.equal(await readText(SKILL_EXTRA), "extra");
            assert.equal((await readManifest(dataDir)).files[SKILL_EXTRA], sha256("extra"));
        });
    });

    describe("a file no longer shipped", () => {
        beforeEach(async () => {
            await putFiles(shippedRoot, { [SKILL_EXTRA]: "extra" });
            await prepare();
        });

        it("removes an unedited file and the skill folders it leaves empty, and drops it from the manifest", async () => {
            await rm(join(shippedRoot, "skills/alpha"), { recursive: true });
            await prepare();
            await assert.rejects(stat(join(dataDir, "skills/alpha")), { code: "ENOENT" });
            assert.ok((await stat(skillsFolderPath(dataDir))).isDirectory());
            assert.deepEqual(Object.keys((await readManifest(dataDir)).files).sort(), [COMMON, ROLE]);
        });

        it("keeps the skill folder while another file is in it", async () => {
            await rm(join(shippedRoot, SKILL_EXTRA));
            await prepare();
            assert.equal(await readText(SKILL), "skill 1");
            await assert.rejects(readText(SKILL_EXTRA), { code: "ENOENT" });
            assert.ok((await stat(join(dataDir, "skills/alpha"))).isDirectory());
        });

        it("keeps an edited file and still drops it from the manifest", async () => {
            await writeFile(join(dataDir, SKILL_EXTRA), "mine");
            await rm(join(shippedRoot, SKILL_EXTRA));
            await prepare();
            assert.equal(await readText(SKILL_EXTRA), "mine");
            assert.equal((await readManifest(dataDir)).files[SKILL_EXTRA], undefined);
        });

        it("drops a deleted file from the manifest", async () => {
            await rm(join(dataDir, ROLE));
            await rm(join(shippedRoot, ROLE));
            await prepare();
            assert.equal((await readManifest(dataDir)).files[ROLE], undefined);
        });
    });

    describe("a file already at an unrecorded path", () => {
        it("keeps its text and counts it as edited when it differs", async () => {
            await putFiles(dataDir, { [COMMON]: "mine" });
            await prepare();
            assert.equal(await readText(COMMON), "mine");
            assert.equal((await readManifest(dataDir)).files[COMMON], sha256("common 1"));
            const states = await shippedFileStates({ dataDir, shippedRoot });
            assert.deepEqual(states[COMMON], { edited: true, missing: false });
        });

        it("counts it as unedited when it equals the shipped bytes", async () => {
            await putFiles(dataDir, { [COMMON]: "common 1" });
            await prepare();
            const states = await shippedFileStates({ dataDir, shippedRoot });
            assert.deepEqual(states[COMMON], { edited: false, missing: false });
        });
    });

    describe("shippedFileStates", () => {
        it("marks each shipped path edited, missing or neither", async () => {
            await prepare();
            await writeFile(join(dataDir, COMMON), "mine");
            await rm(join(dataDir, ROLE));
            assert.deepEqual(await shippedFileStates({ dataDir, shippedRoot }), {
                [COMMON]: { edited: true, missing: false },
                [ROLE]: { edited: true, missing: true },
                [SKILL]: { edited: false, missing: false },
            });
        });

        it("marks a shipped file that was never copied as missing and unedited", async () => {
            assert.deepEqual((await shippedFileStates({ dataDir, shippedRoot }))[COMMON], {
                edited: false,
                missing: true,
            });
        });
    });

    describe("a failed write", () => {
        it("throws an error naming the path", async () => {
            await mkdir(dataDir, { recursive: true });
            await writeFile(join(dataDir, "instructions"), "a file where the folder belongs");
            await assert.rejects(
                prepare(),
                (error) =>
                    error instanceof InternalFolderError &&
                    error.path.startsWith(join(dataDir, "instructions")) &&
                    error.message.includes(error.path),
            );
        });

        it("never writes under the shipped root", async () => {
            await prepare();
            await putFiles(shippedRoot, { [COMMON]: "common 2" });
            await rm(join(shippedRoot, SKILL));
            const before = await listTree(shippedRoot);
            await chmod(shippedRoot, 0o500);
            await prepare();
            assert.deepEqual(await listTree(shippedRoot), before);
        });
    });
});
