import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    FAKE_OAUTH_CLIENT_SECRET,
    type FakeOAuthProvider,
    startFakeOAuthProvider,
} from "../support/fake_oauth_provider.ts";

const TENANT = "contoso";
const CLIENT_ID = "client-1";

type Answer = { status: number; body: Record<string, string | number> };

let provider: FakeOAuthProvider | undefined;

afterEach(async () => {
    await provider?.stop();
    provider = undefined;
});

async function start(accessTokenSeconds = 3600): Promise<FakeOAuthProvider> {
    provider = await startFakeOAuthProvider({ accessTokenSeconds });
    return provider;
}

async function post(url: string, form: Record<string, string>): Promise<Answer> {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
    });
    return { status: response.status, body: (await response.json()) as Answer["body"] };
}

function microsoftUrl(base: string, endpoint: "devicecode" | "token"): string {
    return `${base}/${TENANT}/oauth2/v2.0/${endpoint}`;
}

async function requestDeviceCode(fake: FakeOAuthProvider): Promise<Answer> {
    return post(microsoftUrl(fake.endpoints.microsoftBase, "devicecode"), {
        client_id: CLIENT_ID,
        scope: "offline_access",
    });
}

function pollDeviceCode(fake: FakeOAuthProvider, deviceCode: string): Promise<Answer> {
    return post(microsoftUrl(fake.endpoints.microsoftBase, "token"), {
        client_id: CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
    });
}

describe("the fake OAuth provider's device code flow", () => {
    it("answers a device code request with a user code and an address", async () => {
        const fake = await start();

        const answer = await requestDeviceCode(fake);

        assert.equal(answer.status, 200);
        assert.equal(typeof answer.body.user_code, "string");
        assert.equal(typeof answer.body.device_code, "string");
        assert.equal(typeof answer.body.verification_uri, "string");
    });

    it("answers token polls authorization_pending until the code is entered", async () => {
        const fake = await start();
        const code = (await requestDeviceCode(fake)).body;

        const pending = await pollDeviceCode(fake, String(code.device_code));

        assert.equal(pending.status, 400);
        assert.equal(pending.body.error, "authorization_pending");
    });

    it("answers with an access token and a refresh token once the code is entered", async () => {
        const fake = await start();
        const code = (await requestDeviceCode(fake)).body;

        fake.enterCode(String(code.user_code));
        const tokens = await pollDeviceCode(fake, String(code.device_code));

        assert.equal(tokens.status, 200);
        assert.equal(fake.isValidAccessToken(String(tokens.body.access_token)), true);
        assert.equal(typeof tokens.body.refresh_token, "string");
    });
});

async function signInWithDeviceCode(fake: FakeOAuthProvider): Promise<Answer["body"]> {
    const code = (await requestDeviceCode(fake)).body;
    fake.enterCode(String(code.user_code));
    return (await pollDeviceCode(fake, String(code.device_code))).body;
}

function refresh(fake: FakeOAuthProvider, refreshToken: string): Promise<Answer> {
    return post(microsoftUrl(fake.endpoints.microsoftBase, "token"), {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
    });
}

describe("the fake OAuth provider's refresh tokens", () => {
    it("returns a new access token and a new refresh token on each refresh", async () => {
        const fake = await start();
        const first = await signInWithDeviceCode(fake);

        const second = await refresh(fake, String(first.refresh_token));

        assert.equal(second.status, 200);
        assert.notEqual(second.body.access_token, first.access_token);
        assert.notEqual(second.body.refresh_token, first.refresh_token);
        assert.equal(fake.isValidAccessToken(String(second.body.access_token)), true);
    });

    it("refuses a refresh token that was used", async () => {
        const fake = await start();
        const first = await signInWithDeviceCode(fake);
        await refresh(fake, String(first.refresh_token));

        const again = await refresh(fake, String(first.refresh_token));

        assert.equal(again.status, 400);
        assert.equal(again.body.error, "invalid_grant");
    });

    it("accepts the newest refresh token after several refreshes", async () => {
        const fake = await start();
        let latest = String((await signInWithDeviceCode(fake)).refresh_token);

        for (let round = 0; round < 3; round += 1) {
            const answer = await refresh(fake, latest);
            assert.equal(answer.status, 200);
            latest = String(answer.body.refresh_token);
        }
    });

    it("refuses a revoked refresh token with invalid_grant and a message", async () => {
        const fake = await start();
        const first = await signInWithDeviceCode(fake);

        fake.revoke(String(first.refresh_token));
        const answer = await refresh(fake, String(first.refresh_token));

        assert.equal(answer.status, 400);
        assert.equal(answer.body.error, "invalid_grant");
        assert.match(String(answer.body.error_description), /\S/);
    });

    it("refuses a refresh token it never issued", async () => {
        const fake = await start();

        const answer = await refresh(fake, "unknown");

        assert.equal(answer.body.error, "invalid_grant");
    });
});

describe("the fake OAuth provider's client credentials", () => {
    function clientCredentials(fake: FakeOAuthProvider, secret: string): Promise<Answer> {
        return post(microsoftUrl(fake.endpoints.microsoftBase, "token"), {
            client_id: CLIENT_ID,
            grant_type: "client_credentials",
            client_secret: secret,
            scope: "https://outlook.office365.com/.default",
        });
    }

    it("answers with an access token when the client secret is right", async () => {
        const fake = await start();

        const answer = await clientCredentials(fake, FAKE_OAUTH_CLIENT_SECRET);

        assert.equal(answer.status, 200);
        assert.equal(fake.isValidAccessToken(String(answer.body.access_token)), true);
    });

    it("refuses a wrong client secret with invalid_client", async () => {
        const fake = await start();

        const answer = await clientCredentials(fake, "wrong");

        assert.equal(answer.status, 401);
        assert.equal(answer.body.error, "invalid_client");
    });
});
