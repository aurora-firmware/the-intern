import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeOAuthOptions = {
    /** How long an access token the provider hands out stays valid. */
    accessTokenSeconds: number;
};

export type FakeOAuthEndpoints = {
    /** Stands in for `https://login.microsoftonline.com`; the tenant and the `oauth2/v2.0/...` path follow it. */
    microsoftBase: string;
    /** Stands in for `https://accounts.google.com/o/oauth2/v2/auth`. */
    googleAuthorize: string;
    /** Stands in for `https://oauth2.googleapis.com/token`. */
    googleToken: string;
};

export type FakeOAuthProvider = {
    endpoints: FakeOAuthEndpoints;
    enterCode(userCode: string): void;
    /** Plays the browser: redirects to the loopback address in the URL with a code and the URL's `state`. */
    answerGoogle(authorizationUrl: string): Promise<void>;
    revoke(refreshToken: string): void;
    /** Every request the provider received, in order, with its form body. */
    requests(): ReceivedRequest[];
    isValidAccessToken(token: string): boolean;
    stop(): Promise<void>;
};

export type ReceivedRequest = { path: string; body: Record<string, string> };

type Answer = { status: number; body: Record<string, string | number> };

type RefreshTokenState = { isUsed: boolean; revokedMessage?: string };

type GoogleCode = { challenge: string };

type DeviceGrant = { userCode: string; isEntered: boolean };

/** The client secret the provider accepts, for the client credentials and the Google token requests. */
export const FAKE_OAUTH_CLIENT_SECRET = "fake-oauth-client-secret";

const LOOPBACK = "127.0.0.1";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MICROSOFT_PREFIX = "/microsoft";
const DEVICE_CODE_PATH = /^\/microsoft\/[^/]+\/oauth2\/v2\.0\/devicecode$/;
const MICROSOFT_TOKEN_PATH = /^\/microsoft\/[^/]+\/oauth2\/v2\.0\/token$/;
const GOOGLE_TOKEN_PATH = "/google/token";

const REVOKED_MESSAGE = "The refresh token was revoked.";
const USED_MESSAGE = "The refresh token was already used; a newer one replaced it.";

function newSecret(): string {
    return randomBytes(16).toString("hex");
}

function invalidClient(): Answer {
    return { status: 401, body: { error: "invalid_client", error_description: "The client secret is wrong." } };
}

function invalidGrant(message: string): Answer {
    return { status: 400, body: { error: "invalid_grant", error_description: message } };
}

async function readForm(request: http.IncomingMessage): Promise<Record<string, string>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** Serves the OAuth 2.0 endpoints of Google and Microsoft on a loopback port the system picks. */
export async function startFakeOAuthProvider(options: FakeOAuthOptions): Promise<FakeOAuthProvider> {
    const accessTokens = new Map<string, number>();
    const deviceGrants = new Map<string, DeviceGrant>();
    const refreshTokens = new Map<string, RefreshTokenState>();
    const googleCodes = new Map<string, GoogleCode>();
    const received: ReceivedRequest[] = [];

    function issueRefreshToken(): string {
        const token = newSecret();
        refreshTokens.set(token, { isUsed: false });
        return token;
    }

    function tokenBody(): Answer["body"] {
        return {
            token_type: "Bearer",
            access_token: issueAccessToken(),
            refresh_token: issueRefreshToken(),
            expires_in: options.accessTokenSeconds,
        };
    }

    function answerRefresh(form: Record<string, string>): Answer {
        const state = refreshTokens.get(form.refresh_token ?? "");
        if (!state) return invalidGrant("The refresh token is unknown.");
        if (state.revokedMessage) return invalidGrant(state.revokedMessage);
        if (state.isUsed) return invalidGrant(USED_MESSAGE);
        state.isUsed = true;
        return { status: 200, body: tokenBody() };
    }

    function answerClientCredentials(form: Record<string, string>): Answer {
        if (form.client_secret !== FAKE_OAUTH_CLIENT_SECRET) return invalidClient();
        return {
            status: 200,
            body: { token_type: "Bearer", access_token: issueAccessToken(), expires_in: options.accessTokenSeconds },
        };
    }

    function issueAccessToken(): string {
        const token = newSecret();
        accessTokens.set(token, Date.now() + options.accessTokenSeconds * 1000);
        return token;
    }

    function answerDeviceCode(): Answer {
        const deviceCode = newSecret();
        const userCode = newSecret().slice(0, 8);
        deviceGrants.set(deviceCode, { userCode, isEntered: false });
        return {
            status: 200,
            body: {
                device_code: deviceCode,
                user_code: userCode,
                verification_uri: `${endpoints.microsoftBase}/devicelogin`,
                expires_in: 900,
                interval: 1,
            },
        };
    }

    function answerAuthorizationCode(form: Record<string, string>): Answer {
        if (form.client_secret !== FAKE_OAUTH_CLIENT_SECRET) return invalidClient();
        const code = googleCodes.get(form.code ?? "");
        googleCodes.delete(form.code ?? "");
        const verifierChallenge = createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url");
        if (!code || code.challenge !== verifierChallenge) return invalidGrant("The code or its verifier is wrong.");
        return { status: 200, body: tokenBody() };
    }

    function answerToken(form: Record<string, string>): Answer {
        if (form.grant_type === "refresh_token") return answerRefresh(form);
        if (form.grant_type === "authorization_code") return answerAuthorizationCode(form);
        if (form.grant_type === "client_credentials") return answerClientCredentials(form);
        const grant = deviceGrants.get(form.device_code ?? "");
        if (form.grant_type !== DEVICE_CODE_GRANT || !grant) return invalidGrant("The device code is unknown.");
        if (!grant.isEntered) return { status: 400, body: { error: "authorization_pending" } };
        return { status: 200, body: tokenBody() };
    }

    async function route(request: http.IncomingMessage): Promise<Answer> {
        const path = new URL(request.url ?? "", "http://localhost").pathname;
        const form = await readForm(request);
        received.push({ path, body: form });
        if (DEVICE_CODE_PATH.test(path)) return answerDeviceCode();
        if (MICROSOFT_TOKEN_PATH.test(path) || path === GOOGLE_TOKEN_PATH) return answerToken(form);
        return { status: 404, body: { error: "not_found" } };
    }

    const server = http.createServer((request, response) => {
        void route(request).then((answer) => {
            response.writeHead(answer.status, { "content-type": "application/json" });
            response.end(JSON.stringify(answer.body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
    const base = `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`;
    const endpoints: FakeOAuthEndpoints = {
        microsoftBase: `${base}${MICROSOFT_PREFIX}`,
        googleAuthorize: `${base}/google/auth`,
        googleToken: `${base}/google/token`,
    };

    return {
        endpoints,
        enterCode(userCode) {
            const grant = [...deviceGrants.values()].find((candidate) => candidate.userCode === userCode);
            if (!grant) throw new Error(`The fake OAuth provider issued no user code ${userCode}.`);
            grant.isEntered = true;
        },
        async answerGoogle(authorizationUrl) {
            const query = new URL(authorizationUrl).searchParams;
            const redirectUri = query.get("redirect_uri");
            const challenge = query.get("code_challenge");
            if (!redirectUri || !challenge || query.get("code_challenge_method") !== "S256") {
                throw new Error(
                    `The authorization address ${authorizationUrl} lacks a redirect_uri or an S256 challenge.`,
                );
            }
            const code = newSecret();
            googleCodes.set(code, { challenge });
            const redirect = new URL(redirectUri);
            redirect.searchParams.set("code", code);
            redirect.searchParams.set("state", query.get("state") ?? "");
            await fetch(redirect, { redirect: "manual" });
        },
        requests() {
            return received.map((request) => ({ path: request.path, body: { ...request.body } }));
        },
        revoke(refreshToken) {
            const state = refreshTokens.get(refreshToken);
            if (!state) throw new Error("The fake OAuth provider issued no such refresh token.");
            state.revokedMessage = REVOKED_MESSAGE;
        },
        isValidAccessToken(token) {
            const expiresAt = accessTokens.get(token);
            return expiresAt !== undefined && Date.now() < expiresAt;
        },
        stop() {
            server.closeAllConnections();
            return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
