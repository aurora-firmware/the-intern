import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    createFileChangeHub,
    createFileStore,
    type FileChange,
    FileRefusedError,
    MAX_FILE_BYTES,
    writeFileAtomic,
} from "../../src/skills/file_store.ts";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const refusal = (kind: string) => (error: unknown) => error instanceof FileRefusedError && error.kind === kind;

describe("the file store", () => {
    let directory: string;
    let file: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "file-store-"));
        file = join(directory, "note.md");
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    describe("read", () => {
        it("returns the text and the SHA-256 hex of the bytes as the version", async () => {
            await writeFile(file, "héllo\n");
            const result = await createFileStore().read(file);
            assert.deepEqual(result, { text: "héllo\n", version: sha256(Buffer.from("héllo\n")) });
        });

        it("refuses not_found for a missing file", async () => {
            await assert.rejects(createFileStore().read(file), refusal("not_found"));
        });

        it("refuses invalid for a folder", async () => {
            await assert.rejects(createFileStore().read(directory), refusal("invalid"));
        });

        it("refuses invalid for a file over 1 MiB", async () => {
            await writeFile(file, Buffer.alloc(MAX_FILE_BYTES + 1, "a"));
            await assert.rejects(createFileStore().read(file), refusal("invalid"));
        });

        it("reads a file of exactly 1 MiB", async () => {
            await writeFile(file, Buffer.alloc(MAX_FILE_BYTES, "a"));
            assert.equal((await createFileStore().read(file)).text.length, MAX_FILE_BYTES);
        });

        it("refuses invalid for bytes that are not UTF-8", async () => {
            await writeFile(file, Buffer.from([0xff, 0xfe, 0x41]));
            await assert.rejects(createFileStore().read(file), refusal("invalid"));
        });
    });

    describe("write", () => {
        it("creates a missing file with mode 0600 and returns the new token", async () => {
            const version = await createFileStore().write(file, "one");
            assert.equal(await readFile(file, "utf8"), "one");
            assert.equal(version, sha256("one"));
            assert.equal((await stat(file)).mode & 0o777, 0o600);
        });

        it("replaces the file when the token matches", async () => {
            await writeFile(file, "old");
            const store = createFileStore();
            const { version } = await store.read(file);
            const next = await store.write(file, "new", { version });
            assert.equal(await readFile(file, "utf8"), "new");
            assert.equal(next, sha256("new"));
        });

        it("refuses conflict and leaves the file unchanged when it changed since the token was read", async () => {
            await writeFile(file, "old");
            const store = createFileStore();
            const { version } = await store.read(file);
            await writeFile(file, "someone else");
            await assert.rejects(store.write(file, "new", { version }), refusal("conflict"));
            assert.equal(await readFile(file, "utf8"), "someone else");
        });

        it("refuses not_found when a token is given and the file is missing", async () => {
            await assert.rejects(
                createFileStore().write(file, "new", { version: sha256("old") }),
                refusal("not_found"),
            );
            await assert.rejects(stat(file), { code: "ENOENT" });
        });

        it("refuses invalid for text over 1 MiB and leaves the file unchanged", async () => {
            await writeFile(file, "old");
            await assert.rejects(createFileStore().write(file, "a".repeat(MAX_FILE_BYTES + 1)), refusal("invalid"));
            assert.equal(await readFile(file, "utf8"), "old");
        });

        it("keeps the mode of the file it replaces", async () => {
            await writeFile(file, "old");
            await chmod(file, 0o640);
            await createFileStore().write(file, "new");
            assert.equal((await stat(file)).mode & 0o777, 0o640);
        });

        it("writes the target of a symbolic link and keeps the link", async () => {
            const target = join(directory, "target.md");
            await writeFile(target, "old");
            await symlink(target, file);
            await createFileStore().write(file, "new");
            assert.equal(await readFile(target, "utf8"), "new");
            assert.equal((await stat(file)).isFile(), true);
            assert.equal((await import("node:fs/promises").then((fs) => fs.lstat(file))).isSymbolicLink(), true);
        });

        it("writes the target in its own folder when the link sits in another", async () => {
            const other = join(directory, "other");
            await mkdir(other);
            const target = join(other, "target.md");
            await writeFile(target, "old");
            await symlink(target, file);
            await createFileStore().write(file, "new");
            assert.deepEqual(await readdir(other), ["target.md"]);
        });

        it("leaves no temporary file behind", async () => {
            await createFileStore().write(file, "one");
            await createFileStore().write(file, "two");
            assert.deepEqual(await readdir(directory), ["note.md"]);
        });

        it("leaves no temporary file when the rename fails", async () => {
            await mkdir(file);
            await assert.rejects(writeFileAtomic(file, Buffer.from("x")));
            assert.deepEqual(await readdir(directory), ["note.md"]);
        });
    });

    describe("remove", () => {
        it("deletes the file", async () => {
            await writeFile(file, "x");
            await createFileStore().remove(file);
            await assert.rejects(stat(file), { code: "ENOENT" });
        });

        it("refuses not_found for a missing file", async () => {
            await assert.rejects(createFileStore().remove(file), refusal("not_found"));
        });

        it("announces the removal only after the file is gone", async () => {
            await writeFile(file, "x");
            const hub = createFileChangeHub();
            const seen: FileChange[] = [];
            const existedAtAnnouncement: boolean[] = [];
            hub.onChange((change) => {
                seen.push(change);
                existedAtAnnouncement.push(existsSync(file));
            });
            await createFileStore({ changes: () => hub }).remove(file, { announce: "skill" });
            assert.deepEqual(seen, [{ path: file, kind: "skill" }]);
            assert.deepEqual(existedAtAnnouncement, [false]);
        });
    });

    describe("the serial queue", () => {
        it("runs writes made at once one after the other", async () => {
            const store = createFileStore();
            const order: string[] = [];
            const first = store.enqueue(async () => {
                order.push("first start");
                await new Promise((resolve) => setTimeout(resolve, 20));
                order.push("first end");
            });
            const second = store.enqueue(async () => {
                order.push("second start");
            });
            await Promise.all([first, second]);
            assert.deepEqual(order, ["first start", "first end", "second start"]);
        });

        it("applies concurrent writes in call order", async () => {
            const store = createFileStore();
            await Promise.all([store.write(file, "a"), store.write(file, "b"), store.write(file, "c")]);
            assert.equal(await readFile(file, "utf8"), "c");
        });

        it("lets one concurrent write with the same token win and refuses the other", async () => {
            await writeFile(file, "old");
            const store = createFileStore();
            const { version } = await store.read(file);
            const results = await Promise.allSettled([
                store.write(file, "a", { version }),
                store.write(file, "b", { version }),
            ]);
            assert.deepEqual(
                results.map((result) => result.status),
                ["fulfilled", "rejected"],
            );
            assert.equal(await readFile(file, "utf8"), "a");
        });

        it("keeps running after a job fails", async () => {
            const store = createFileStore();
            await assert.rejects(
                store.enqueue(async () => {
                    throw new Error("boom");
                }),
                /boom/,
            );
            assert.equal(await store.enqueue(async () => "next"), "next");
        });

        it("publishes an announced change after its write, in write order", async () => {
            const hub = createFileChangeHub();
            const seen: Array<{ change: FileChange; text: string }> = [];
            hub.onChange((change) => {
                seen.push({ change, text: readFileSync(change.path, "utf8") });
            });
            const store = createFileStore({ changes: () => hub });
            const other = join(directory, "other.md");
            await Promise.all([
                store.write(file, "one", { announce: "role" }),
                store.write(other, "two", { announce: "common" }),
                store.write(file, "silent"),
            ]);
            assert.deepEqual(seen, [
                { change: { path: file, kind: "role" }, text: "one" },
                { change: { path: other, kind: "common" }, text: "two" },
            ]);
        });

        it("writes without a hub when the changes lookup returns nothing", async () => {
            await createFileStore({ changes: () => undefined }).write(file, "one", { announce: "role" });
            assert.equal(await readFile(file, "utf8"), "one");
        });
    });
});

describe("the file change hub", () => {
    it("delivers a change to every listener until it unsubscribes", () => {
        const hub = createFileChangeHub();
        const first: FileChange[] = [];
        const second: FileChange[] = [];
        const stop = hub.onChange((change) => first.push(change));
        hub.onChange((change) => second.push(change));
        hub.publish({ path: "/a", kind: "workspace" });
        stop();
        hub.publish({ path: "/b", kind: "instructions" });
        assert.deepEqual(first, [{ path: "/a", kind: "workspace" }]);
        assert.deepEqual(second, [
            { path: "/a", kind: "workspace" },
            { path: "/b", kind: "instructions" },
        ]);
    });

    it("keeps delivering when a listener throws", () => {
        const hub = createFileChangeHub();
        const seen: FileChange[] = [];
        hub.onChange(() => {
            throw new Error("bad listener");
        });
        hub.onChange((change) => seen.push(change));
        hub.publish({ path: "/a", kind: "common" });
        assert.equal(seen.length, 1);
    });
});
