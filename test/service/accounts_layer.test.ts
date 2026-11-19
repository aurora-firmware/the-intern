import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createAccountStatusHub } from "../../src/accounts/account_status.ts";
import type { AccountAuth } from "../../src/accounts/providers.ts";
import { createSecretsStore, type SecretsStore } from "../../src/accounts/secrets_store.ts";
import { type AccountsLayer, CredentialFailure, createAccountsLayer } from "../../src/accounts/sign_in.ts";
import { type FakeOAuthProvider, startFakeOAuthProvider } from "../support/fake_oauth_provider.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const KEY = "mail/work";
const LOGIN = "bob@example.test";
const SCOPES = ["offline_access"];
const START = new Date("2026-11-19T10:00:00Z");
const PASSWORD_COMMAND_LIMIT_BYTES = 64 * 1024;

const clock = { now: () => START, wait: () => new Promise<void>(() => {}) };

const passwordAuth: AccountAuth = { key: KEY, kind: "password", login: LOGIN };
const microsoftAuth: AccountAuth = {
    key: KEY,
    kind: "microsoft",
    login: LOGIN,
    clientId: "client-1",
    tenant: "contoso",
};

function commandAuth(script: string): AccountAuth {
    return { key: KEY, kind: "password_command", login: LOGIN, passwordCommand: [process.execPath, "-e", script] };
}

async function failureOf(promise: Promise<unknown>): Promise<CredentialFailure> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof CredentialFailure, `expected CredentialFailure, got ${String(error)}`);
        return error;
    }
    throw new assert.AssertionError({ message: "expected a CredentialFailure, but the call returned" });
}

describe("The accounts layer", () => {
    let hermetic: HermeticEnv;
    let secrets: SecretsStore;
    let fake: FakeOAuthProvider;
    let layer: AccountsLayer;

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
        const secretsDir = join(hermetic.root, "secrets");
        await mkdir(secretsDir, { mode: 0o700 });
        secrets = createSecretsStore({ secretsDir });
        fake = await startFakeOAuthProvider({ accessTokenSeconds: 3600 });
        layer = createAccountsLayer({
            secrets,
            status: createAccountStatusHub({ clock }),
            endpoints: fake.endpoints,
            clock,
        });
    });

    afterEach(async () => {
        await fake.stop();
        await hermetic.dispose();
    });

    it("returns the login and the stored password for a password account", async () => {
        await layer.setSecret(KEY, { password: "hunter2" });
        assert.deepEqual(await layer.credentialFor(passwordAuth, SCOPES), { user: LOGIN, password: "hunter2" });
    });

    it("runs the password command at each login and removes one trailing line end", async () => {
        const counter = join(hermetic.root, "runs");
        const script = `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.stdout.write("s3cret\\n\\n")`;
        const auth = commandAuth(script);
        assert.deepEqual(await layer.credentialFor(auth, SCOPES), { user: LOGIN, password: "s3cret\n" });
        await layer.credentialFor(auth, SCOPES);
        assert.equal(await readFile(counter, "utf8"), "xx");
    });

    it("removes a carriage return and line feed as one line end", async () => {
        const credential = await layer.credentialFor(commandAuth(`process.stdout.write("pw\\r\\n")`), SCOPES);
        assert.deepEqual(credential, { user: LOGIN, password: "pw" });
    });

    it("runs the command without a shell", async () => {
        const auth: AccountAuth = {
            key: KEY,
            kind: "password_command",
            login: LOGIN,
            passwordCommand: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "$(echo hi);x"],
        };
        assert.deepEqual(await layer.credentialFor(auth, SCOPES), { user: LOGIN, password: "$(echo hi);x" });
    });

    it("fails with the exit status and never the command's output when it exits non-zero", async () => {
        const script = `process.stdout.write("LEAKED-OUT"); process.stderr.write("LEAKED-ERR"); process.exit(3)`;
        const failure = await failureOf(layer.credentialFor(commandAuth(script), SCOPES));
        assert.equal(failure.kind, "failing");
        assert.match(failure.message, /status 3/);
        assert.doesNotMatch(failure.message, /LEAKED/);
    });

    it("fails when the command prints nothing", async () => {
        const failure = await failureOf(layer.credentialFor(commandAuth("0"), SCOPES));
        assert.equal(failure.kind, "failing");
        assert.match(failure.message, /nothing/);
    });

    it("fails naming the limit when the command prints over 64 KiB, and never its output", async () => {
        const script = `process.stdout.write("LEAKED".repeat(${PASSWORD_COMMAND_LIMIT_BYTES}))`;
        const failure = await failureOf(layer.credentialFor(commandAuth(script), SCOPES));
        assert.equal(failure.kind, "failing");
        assert.match(failure.message, /64 KiB/);
        assert.doesNotMatch(failure.message, /LEAKED/);
    });

    it("accepts a command that prints exactly 64 KiB", async () => {
        const script = `process.stdout.write("a".repeat(${PASSWORD_COMMAND_LIMIT_BYTES}))`;
        const credential = await layer.credentialFor(commandAuth(script), SCOPES);
        assert.ok("password" in credential);
        assert.equal(credential.password.length, PASSWORD_COMMAND_LIMIT_BYTES);
    });

    it("fails naming the time limit when the command runs over it", async () => {
        const slowLayer = createAccountsLayer({
            secrets,
            status: createAccountStatusHub({ clock }),
            endpoints: fake.endpoints,
            clock,
            passwordCommandTimeoutMs: 300,
        });
        const failure = await failureOf(slowLayer.credentialFor(commandAuth("setInterval(() => {}, 1000)"), SCOPES));
        assert.equal(failure.kind, "failing");
        assert.match(failure.message, /time limit/);
    });

    it("fails when the command cannot be started", async () => {
        const auth: AccountAuth = {
            key: KEY,
            kind: "password_command",
            login: LOGIN,
            passwordCommand: [join(hermetic.root, "no-such-program")],
        };
        const failure = await failureOf(layer.credentialFor(auth, SCOPES));
        assert.equal(failure.kind, "failing");
    });

    it("returns the login with the access token for an OAuth account", async () => {
        const code = await fetch(`${fake.endpoints.microsoftBase}/contoso/oauth2/v2.0/devicecode`, {
            method: "POST",
            body: new URLSearchParams({ client_id: "client-1" }),
        }).then((r) => r.json() as Promise<Record<string, string>>);
        fake.enterCode(String(code.user_code));
        const tokens = (await fetch(`${fake.endpoints.microsoftBase}/contoso/oauth2/v2.0/token`, {
            method: "POST",
            body: new URLSearchParams({
                client_id: "client-1",
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: String(code.device_code),
            }),
        }).then((r) => r.json())) as Record<string, string>;
        await secrets.write(KEY, { refreshToken: String(tokens.refresh_token) });
        const credential = await layer.credentialFor(microsoftAuth, SCOPES);
        assert.ok("accessToken" in credential);
        assert.equal(credential.user, LOGIN);
        assert.ok(credential.accessToken.length > 0);
    });

    it("throws needs_sign_in with the provider's message when an OAuth account has no usable sign-in", async () => {
        await secrets.write(KEY, { refreshToken: "revoked-or-unknown" });
        const failure = await failureOf(layer.credentialFor(microsoftAuth, SCOPES));
        assert.equal(failure.kind, "needs_sign_in");
        assert.ok(failure.message.length > 0);
    });

    it("throws needs_sign_in when a password account has no stored password", async () => {
        const failure = await failureOf(layer.credentialFor(passwordAuth, SCOPES));
        assert.equal(failure.kind, "needs_sign_in");
    });

    it("answers needsSignIn with true for each auth that lacks its secret and false once stored", async () => {
        const appAuth: AccountAuth = { ...microsoftAuth, kind: "microsoft_app" };
        const googleAuth: AccountAuth = { ...microsoftAuth, kind: "google" };
        assert.equal(await layer.needsSignIn(passwordAuth), true);
        assert.equal(await layer.needsSignIn(googleAuth), true);
        assert.equal(await layer.needsSignIn(microsoftAuth), true);
        assert.equal(await layer.needsSignIn(appAuth), true);
        assert.equal(await layer.needsSignIn(commandAuth("0")), false);

        await secrets.write(KEY, { password: "p", refreshToken: "r", clientSecret: "c" });
        assert.equal(await layer.needsSignIn(passwordAuth), false);
        assert.equal(await layer.needsSignIn(googleAuth), false);
        assert.equal(await layer.needsSignIn(microsoftAuth), false);
        assert.equal(await layer.needsSignIn(appAuth), false);
    });

    it("keeps the other secret values when setSecret sets one", async () => {
        await secrets.write(KEY, { refreshToken: "r" });
        await layer.setSecret(KEY, { password: "p" });
        await layer.setSecret(KEY, { clientSecret: "c" });
        assert.deepEqual(await secrets.read(KEY), { refreshToken: "r", password: "p", clientSecret: "c" });
    });

    it("removes one account's secret and, with removeUnknownAccounts, every other", async () => {
        await secrets.write("mail/a", { password: "1" });
        await secrets.write("mail/b", { password: "2" });
        await secrets.write("mail/c", { password: "3" });
        await layer.removeAccount("mail/a");
        await layer.removeUnknownAccounts(["mail/b"]);
        assert.deepEqual(await secrets.keys(), ["mail/b"]);
    });

    it("exposes the status hub it was given", () => {
        const status = createAccountStatusHub({ clock });
        const own = createAccountsLayer({ secrets, status, endpoints: fake.endpoints, clock });
        assert.equal(own.status, status);
    });
});
