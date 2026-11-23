import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { accessTokenFor, SignInNeededError } from "../../src/accounts/oauth.ts";
import { type AccountAuth, microsoftTokenUrl } from "../../src/accounts/providers.ts";
import { type AccountSecret, createSecretsStore, type SecretsStore } from "../../src/accounts/secrets_store.ts";
import {
    FAKE_OAUTH_CLIENT_SECRET,
    type FakeOAuthProvider,
    startFakeOAuthProvider,
} from "../support/fake_oauth_provider.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const KEY = "mail/work";
const SCOPES = ["offline_access", "https://outlook.office.com/IMAP.AccessAsUser.All"];
const CLIENT_ID = "client-1";
const TENANT = "contoso";
const START = new Date("2026-11-19T10:00:00Z");
const MINUTE = 60_000;

const microsoftAuth: AccountAuth = {
    key: KEY,
    kind: "microsoft",
    login: "bob@contoso.test",
    clientId: CLIENT_ID,
    tenant: TENANT,
};

describe("OAuth access tokens", () => {
    let hermetic: HermeticEnv;
    let secrets: SecretsStore;
    let fake: FakeOAuthProvider;

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
        const secretsDir = join(hermetic.root, "secrets");
        await mkdir(secretsDir, { mode: 0o700 });
        secrets = createSecretsStore({ secretsDir });
        fake = await startFakeOAuthProvider({ accessTokenSeconds: 3600 });
    });

    afterEach(async () => {
        await fake.stop();
        await hermetic.dispose();
    });

    async function post(url: string, form: Record<string, string>): Promise<Record<string, string | number>> {
        const response = await fetch(url, { method: "POST", body: new URLSearchParams(form) });
        return (await response.json()) as Record<string, string | number>;
    }

    /** Signs in through the fake's device code flow, as the sign-in operation will, and returns the tokens. */
    async function signIn(): Promise<{ accessToken: string; refreshToken: string }> {
        const url = (endpoint: "devicecode" | "token") =>
            `${fake.endpoints.microsoftBase}/${TENANT}/oauth2/v2.0/${endpoint}`;
        const code = await post(url("devicecode"), { client_id: CLIENT_ID });
        fake.enterCode(String(code.user_code));
        const tokens = await post(url("token"), {
            client_id: CLIENT_ID,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: String(code.device_code),
        });
        return { accessToken: String(tokens.access_token), refreshToken: String(tokens.refresh_token) };
    }

    async function storeSignedIn(expiresInMs: number): Promise<{ accessToken: string; refreshToken: string }> {
        const tokens = await signIn();
        await secrets.write(KEY, { ...tokens, accessTokenExpiresAt: START.getTime() + expiresInMs });
        return tokens;
    }

    function request(auth: AccountAuth, store: SecretsStore = secrets) {
        return { auth, scopes: SCOPES, secrets: store, endpoints: fake.endpoints, now: () => START };
    }

    const refreshRequests = () => fake.requests().filter((r) => r.body.grant_type === "refresh_token");

    it("returns the stored access token when it expires in more than 5 minutes", async () => {
        const tokens = await storeSignedIn(6 * MINUTE);

        assert.equal(await accessTokenFor(request(microsoftAuth)), tokens.accessToken);
        assert.equal(refreshRequests().length, 0);
    });

    it("refreshes a token that expires within 5 minutes and stores the new tokens", async () => {
        const old = await storeSignedIn(4 * MINUTE);

        const token = await accessTokenFor(request(microsoftAuth));

        assert.notEqual(token, old.accessToken);
        assert.ok(fake.isValidAccessToken(token));
        const stored = (await secrets.read(KEY)) as AccountSecret;
        assert.equal(stored.accessToken, token);
        assert.notEqual(stored.refreshToken, old.refreshToken);
        assert.equal(stored.accessTokenExpiresAt, START.getTime() + 3600 * 1000);
        assert.equal(refreshRequests()[0]?.body.refresh_token, old.refreshToken);
    });

    it("returns the token only after the store holds it", async () => {
        await storeSignedIn(MINUTE);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let writeStarted: () => void = () => {};
        const started = new Promise<void>((resolve) => {
            writeStarted = resolve;
        });
        const slowStore: SecretsStore = {
            ...secrets,
            write: async (key, secret) => {
                writeStarted();
                await gate;
                await secrets.write(key, secret);
            },
        };
        let isReturned = false;

        const pending = accessTokenFor(request(microsoftAuth, slowStore)).then((token) => {
            isReturned = true;
            return token;
        });
        await started;
        await Promise.resolve();
        assert.equal(isReturned, false);
        release();
        const token = await pending;

        assert.equal(((await secrets.read(KEY)) as AccountSecret).accessToken, token);
    });

    it("makes one refresh request for two logins asking at once", async () => {
        await storeSignedIn(MINUTE);

        const [first, second] = await Promise.all([
            accessTokenFor(request(microsoftAuth)),
            accessTokenFor(request(microsoftAuth)),
        ]);

        assert.equal(first, second);
        assert.equal(refreshRequests().length, 1);
    });

    it("throws SignInNeededError with the provider's message when the refresh token was revoked", async () => {
        const old = await storeSignedIn(MINUTE);
        fake.revoke(old.refreshToken);

        const error = await accessTokenFor(request(microsoftAuth)).catch((e: unknown) => e);

        assert.ok(error instanceof SignInNeededError);
        assert.match(error.message, /The refresh token was revoked\./);
    });

    it("throws SignInNeededError when the store holds no refresh token", async () => {
        await secrets.write(KEY, { accessToken: "stale", accessTokenExpiresAt: START.getTime() });

        const error = await accessTokenFor(request(microsoftAuth)).catch((e: unknown) => e);

        assert.ok(error instanceof SignInNeededError);
        assert.equal(fake.requests().length, 0);
    });

    it("refreshes a google account at the google token endpoint with its client secret", async () => {
        const old = await signIn();
        await secrets.write(KEY, {
            ...old,
            clientSecret: FAKE_OAUTH_CLIENT_SECRET,
            accessTokenExpiresAt: START.getTime(),
        });
        const google: AccountAuth = { key: KEY, kind: "google", login: "bob@gmail.test", clientId: CLIENT_ID };

        const token = await accessTokenFor(request(google));

        assert.ok(fake.isValidAccessToken(token));
        const sent = refreshRequests()[0];
        assert.equal(sent?.path, "/google/token");
        assert.equal(sent?.body.client_id, CLIENT_ID);
        assert.equal(sent?.body.client_secret, FAKE_OAUTH_CLIENT_SECRET);
    });

    describe("a microsoft_app account", () => {
        const appAuth: AccountAuth = {
            key: KEY,
            kind: "microsoft_app",
            login: "shared@contoso.test",
            clientId: CLIENT_ID,
            tenant: TENANT,
        };
        const credentialRequests = () => fake.requests().filter((r) => r.body.grant_type === "client_credentials");

        it("gets a token with the client credentials flow and its client secret", async () => {
            await secrets.write(KEY, { clientSecret: FAKE_OAUTH_CLIENT_SECRET });

            const token = await accessTokenFor(request(appAuth));

            assert.ok(fake.isValidAccessToken(token));
            const sent = credentialRequests()[0];
            assert.equal(sent?.path, new URL(microsoftTokenUrl(fake.endpoints.microsoftBase, TENANT)).pathname);
            assert.equal(sent?.body.client_secret, FAKE_OAUTH_CLIENT_SECRET);
            assert.equal(((await secrets.read(KEY)) as AccountSecret).accessToken, token);
        });

        it("reuses the stored token until it expires", async () => {
            await secrets.write(KEY, { clientSecret: FAKE_OAUTH_CLIENT_SECRET });
            const first = await accessTokenFor(request(appAuth));

            const again = await accessTokenFor(request(appAuth));
            const later = await accessTokenFor({
                ...request(appAuth),
                now: () => new Date(START.getTime() + 3600_000),
            });

            assert.equal(again, first);
            assert.notEqual(later, first);
            assert.equal(credentialRequests().length, 2);
        });
    });

    describe("what an error may hold", () => {
        it("holds no refresh token or access token when a refresh is refused", async () => {
            const old = await storeSignedIn(MINUTE);
            fake.revoke(old.refreshToken);

            const error = (await accessTokenFor(request(microsoftAuth)).catch((e: unknown) => e)) as Error;

            assert.ok(!error.message.includes(old.refreshToken));
            assert.ok(!error.message.includes(old.accessToken));
        });

        it("holds no client secret when the provider rejects it", async () => {
            const wrong = "wrong-client-secret-VALUE";
            await secrets.write(KEY, { clientSecret: wrong });
            const appAuth: AccountAuth = {
                key: KEY,
                kind: "microsoft_app",
                login: "a@b.test",
                clientId: CLIENT_ID,
                tenant: TENANT,
            };

            const error = (await accessTokenFor(request(appAuth)).catch((e: unknown) => e)) as Error;

            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes(wrong));
        });
    });
});
