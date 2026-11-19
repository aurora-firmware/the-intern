import { randomBytes } from "node:crypto";
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
    isValidAccessToken(token: string): boolean;
    stop(): Promise<void>;
};

type Answer = { status: number; body: Record<string, string | number> };

type DeviceGrant = { userCode: string; isEntered: boolean };

const LOOPBACK = "127.0.0.1";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MICROSOFT_PREFIX = "/microsoft";
const DEVICE_CODE_PATH = /^\/[^/]+\/oauth2\/v2\.0\/devicecode$/;
const TOKEN_PATH = /^\/[^/]+\/oauth2\/v2\.0\/token$/;

function newSecret(): string {
    return randomBytes(16).toString("hex");
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

    function answerToken(form: Record<string, string>): Answer {
        const grant = deviceGrants.get(form.device_code ?? "");
        if (form.grant_type !== DEVICE_CODE_GRANT || !grant) {
            return { status: 400, body: { error: "invalid_grant" } };
        }
        if (!grant.isEntered) return { status: 400, body: { error: "authorization_pending" } };
        return {
            status: 200,
            body: {
                token_type: "Bearer",
                access_token: issueAccessToken(),
                refresh_token: newSecret(),
                expires_in: options.accessTokenSeconds,
            },
        };
    }

    async function route(request: http.IncomingMessage): Promise<Answer> {
        const path = (request.url ?? "").slice(MICROSOFT_PREFIX.length);
        const form = await readForm(request);
        if (DEVICE_CODE_PATH.test(path)) return answerDeviceCode();
        if (TOKEN_PATH.test(path)) return answerToken(form);
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
