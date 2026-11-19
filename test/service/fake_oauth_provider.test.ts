import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type FakeOAuthProvider, startFakeOAuthProvider } from "../support/fake_oauth_provider.ts";

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
