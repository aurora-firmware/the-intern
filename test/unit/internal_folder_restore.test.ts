import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFileStore } from "../../src/skills/file_store.ts";
import {
    NotShippedError,
    prepareInternalFolder,
    readManifest,
    restoreShippedFile,
    restoreShippedSkill,
    shippedFileStates,
} from "../../src/skills/internal_folder.ts";

const COMMON = "instructions/common.md";
const SKILL = "skills/alpha/SKILL.md";
const SKILL_NESTED = "skills/alpha/notes/more.md";

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

describe("restoring shipped files and skills", () => {
    let base: string;
    let shippedRoot: string;
    let dataDir: string;
    const store = createFileStore();
    const readText = (relative: string) => readFile(join(dataDir, relative), "utf8");
    const restoreFile = (relativePath: string) => restoreShippedFile({ dataDir, shippedRoot, store, relativePath });
    const restoreSkill = (name: string) => restoreShippedSkill({ dataDir, shippedRoot, store, name });
    const states = () => shippedFileStates({ dataDir, shippedRoot });

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), "internal-restore-"));
        shippedRoot = join(base, "shipped");
        dataDir = join(base, "data");
        await putFiles(shippedRoot, { [COMMON]: "common 1", [SKILL]: "skill 1", [SKILL_NESTED]: "more 1" });
        await prepareInternalFolder({ dataDir, shippedRoot, store });
    });

    afterEach(() => rm(base, { recursive: true, force: true }));

    it("writes the installed bytes over an edited shipped file and counts it as not edited", async () => {
        await writeFile(join(dataDir, COMMON), "my edit");
        assert.equal((await states())[COMMON]?.edited, true);

        await restoreFile(COMMON);

        assert.equal(await readText(COMMON), "common 1");
        assert.deepEqual((await states())[COMMON], { edited: false, missing: false });
    });

    it("brings back a deleted shipped file", async () => {
        await rm(join(dataDir, COMMON));

        await restoreFile(COMMON);

        assert.equal(await readText(COMMON), "common 1");
        assert.deepEqual((await states())[COMMON], { edited: false, missing: false });
    });

    it("records the installed hash even when the manifest held a stale one", async () => {
        await putFiles(shippedRoot, { [COMMON]: "common 2" });
        await writeFile(join(dataDir, COMMON), "my edit");

        await restoreFile(COMMON);

        assert.equal(await readText(COMMON), "common 2");
        assert.deepEqual((await states())[COMMON], { edited: false, missing: false });
    });

    it("replaces the whole skill folder, removing files a team member added", async () => {
        await writeFile(join(dataDir, SKILL), "my edit");
        await putFiles(dataDir, { "skills/alpha/extra.md": "mine", "skills/alpha/deep/x.md": "mine" });
        await rm(join(dataDir, SKILL_NESTED));

        await restoreSkill("alpha");

        assert.equal(await readText(SKILL), "skill 1");
        assert.equal(await readText(SKILL_NESTED), "more 1");
        assert.deepEqual(
            (await listTree(join(dataDir, "skills"))).map((line) => line.replace(dataDir, "")),
            [
                "/skills/alpha/",
                "/skills/alpha/SKILL.md=skill 1",
                "/skills/alpha/notes/",
                "/skills/alpha/notes/more.md=more 1",
            ],
        );
        const all = await states();
        assert.deepEqual(all[SKILL], { edited: false, missing: false });
        assert.deepEqual(all[SKILL_NESTED], { edited: false, missing: false });
    });

    it("restores a skill whose folder was deleted", async () => {
        await rm(join(dataDir, "skills", "alpha"), { recursive: true });

        await restoreSkill("alpha");

        assert.equal(await readText(SKILL), "skill 1");
        assert.equal((await readManifest(dataDir)).files[SKILL_NESTED] !== undefined, true);
    });

    it("leaves other shipped files and their edits alone", async () => {
        await writeFile(join(dataDir, COMMON), "my edit");

        await restoreSkill("alpha");

        assert.equal(await readText(COMMON), "my edit");
        assert.equal((await states())[COMMON]?.edited, true);
    });

    it("throws NotShippedError and changes nothing for a file that is not shipped", async () => {
        const before = await listTree(dataDir);

        for (const relativePath of ["instructions/nope.md", "../outside.md", "skills/alpha"]) {
            await assert.rejects(restoreFile(relativePath), (error: unknown) => {
                assert.ok(error instanceof NotShippedError);
                assert.equal(error.name, "NotShippedError");
                assert.equal(error.shippedName, relativePath);
                return true;
            });
        }

        assert.deepEqual(await listTree(dataDir), before);
    });

    it("throws NotShippedError and changes nothing for a skill that is not shipped", async () => {
        await putFiles(dataDir, { "skills/mine/SKILL.md": "mine" });
        const before = await listTree(dataDir);

        for (const name of ["mine", "../instructions", "", "alph"]) {
            await assert.rejects(restoreSkill(name), (error: unknown) => {
                assert.ok(error instanceof NotShippedError);
                assert.equal(error.shippedName, name);
                return true;
            });
        }

        assert.deepEqual(await listTree(dataDir), before);
    });

    it("runs a restore as one job on the store's queue", async () => {
        const order: string[] = [];
        let release: () => void = () => undefined;
        const blocker = store.enqueue(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const restored = restoreFile(COMMON).then(() => order.push("restore"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("before release");
        release();
        await blocker;
        await restored;

        assert.deepEqual(order, ["before release", "restore"]);
    });
});
