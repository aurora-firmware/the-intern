import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSecretsStore, SecretsStoreError } from "../../src/accounts/secrets_store.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const PASSWORD = "hunter2-SECRET-VALUE";

describe("secrets store", () => {
    let hermetic: HermeticEnv;
    let secretsDir: string;

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
        secretsDir = join(hermetic.root, "secrets");
        await mkdir(secretsDir, { mode: 0o700 });
    });

    afterEach(async () => {
        await hermetic.dispose();
    });

    it("reads back what it wrote", async () => {
        const store = createSecretsStore({ secretsDir });
        const secret = { password: PASSWORD, accessToken: "at", accessTokenExpiresAt: 1234 };
        await store.write("mail/intern", secret);
        assert.deepEqual(await store.read("mail/intern"), secret);
    });

    it("reads a missing key as undefined", async () => {
        const store = createSecretsStore({ secretsDir });
        assert.equal(await store.read("mail/none"), undefined);
    });

    it("writes the secret to owner-only files in an owner-only folder", async () => {
        const store = createSecretsStore({ secretsDir });
        const previousUmask = process.umask(0o000);
        try {
            await store.write("mail/intern", { password: PASSWORD });
        } finally {
            process.umask(previousUmask);
        }
        assert.equal((await stat(join(secretsDir, "mail", "intern.json"))).mode & 0o777, 0o600);
        assert.equal((await stat(join(secretsDir, "mail"))).mode & 0o777, 0o700);
        const onDisk = JSON.parse(await readFile(join(secretsDir, "mail", "intern.json"), "utf8"));
        assert.equal(onDisk.password, PASSWORD);
    });

    it("replaces the file by rename and leaves no temporary file", async () => {
        const store = createSecretsStore({ secretsDir });
        const file = join(secretsDir, "mail", "intern.json");
        await store.write("mail/intern", { password: "one" });
        const firstInode = (await stat(file)).ino;
        await store.write("mail/intern", { password: "two" });
        assert.notEqual((await stat(file)).ino, firstInode);
        assert.deepEqual(await readdir(join(secretsDir, "mail")), ["intern.json"]);
    });

    it("applies two writes of one key that start together in order", async () => {
        const store = createSecretsStore({ secretsDir });
        const first = store.write("mail/intern", { password: "first" });
        const second = store.write("mail/intern", { password: "second" });
        await Promise.all([first, second]);
        assert.deepEqual(await store.read("mail/intern"), { password: "second" });
    });

    it("removes a key and accepts removing a missing one", async () => {
        const store = createSecretsStore({ secretsDir });
        await store.write("mail/intern", { password: PASSWORD });
        await store.remove("mail/intern");
        await store.remove("mail/intern");
        assert.equal(await store.read("mail/intern"), undefined);
    });

    it("lists the keys it holds", async () => {
        const store = createSecretsStore({ secretsDir });
        assert.deepEqual(await store.keys(), []);
        await store.write("mail/b", { password: "x" });
        await store.write("mail/a", { password: "x" });
        assert.deepEqual((await store.keys()).sort(), ["mail/a", "mail/b"]);
    });

    it("removes every key except the ones kept", async () => {
        const store = createSecretsStore({ secretsDir });
        await store.write("mail/a", { password: "x" });
        await store.write("mail/b", { password: "y" });
        await store.write("mail/c", { password: "z" });
        await store.removeAllExcept(["mail/a"]);
        assert.deepEqual(await store.keys(), ["mail/a"]);
        assert.deepEqual(await store.read("mail/a"), { password: "x" });
    });

    it("refuses a key that is not <owner>/<name>", async () => {
        const store = createSecretsStore({ secretsDir });
        for (const key of ["intern", "mail/../x", "../mail/x", "mail/a/b", "mail/", "/a"]) {
            await assert.rejects(store.write(key, { password: PASSWORD }), SecretsStoreError, key);
        }
    });

    it("names the key and the cause, and no secret, when a read finds a corrupt file", async () => {
        const store = createSecretsStore({ secretsDir });
        await mkdir(join(secretsDir, "mail"), { mode: 0o700 });
        await writeFile(join(secretsDir, "mail", "intern.json"), `{"password":"${PASSWORD}`);
        await assert.rejects(store.read("mail/intern"), (error: unknown) => {
            assert.ok(error instanceof SecretsStoreError);
            assert.match(error.message, /mail\/intern/);
            assert.match(error.message, /not valid JSON/);
            assert.ok(!error.message.includes(PASSWORD));
            return true;
        });
    });

    it("names the key and the cause, and no secret, when a write fails", async () => {
        const store = createSecretsStore({ secretsDir });
        await writeFile(join(secretsDir, "mail"), "not a folder");
        await assert.rejects(store.write("mail/intern", { password: PASSWORD }), (error: unknown) => {
            assert.ok(error instanceof SecretsStoreError);
            assert.match(error.message, /mail\/intern/);
            assert.match(error.message, /E[A-Z]+/);
            assert.ok(!error.message.includes(PASSWORD));
            return true;
        });
    });

    it("names the key and the cause when a removal fails", async () => {
        const store = createSecretsStore({ secretsDir });
        await mkdir(join(secretsDir, "mail", "intern.json"), { recursive: true });
        await assert.rejects(store.remove("mail/intern"), (error: unknown) => {
            assert.ok(error instanceof SecretsStoreError);
            assert.match(error.message, /mail\/intern/);
            assert.match(error.message, /E[A-Z]+/);
            return true;
        });
    });

    it("keeps serving writes after one fails", async () => {
        const store = createSecretsStore({ secretsDir });
        await assert.rejects(store.write("bad", { password: "x" }), SecretsStoreError);
        await store.write("mail/intern", { password: "ok" });
        assert.deepEqual(await store.read("mail/intern"), { password: "ok" });
    });
});
