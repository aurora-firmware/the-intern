import { createHash, randomBytes } from "node:crypto";
import type { AccountAuth, ProviderEndpoints } from "./providers.ts";
import { microsoftDeviceCodeUrl, microsoftTokenUrl } from "./providers.ts";
import type { AccountSecret, SecretsStore } from "./secrets_store.ts";

/** A token is refreshed when it expires within this long. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type AccessTokenRequest = {
    auth: AccountAuth;
    scopes: readonly string[];
    secrets: SecretsStore;
    endpoints: ProviderEndpoints;
    now: () => Date;
};

/** The account has no usable sign-in: a team member has to sign in again. The message is the provider's. */
export class SignInNeededError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SignInNeededError";
    }
}

export type TokenAnswer = { accessToken: string; refreshToken?: string; expiresInSeconds: number };

/** The token endpoint refused a request. `code` is the provider's `error` value, such as `authorization_pending`. */
export class TokenRefusedError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "TokenRefusedError";
        this.code = code;
    }
}

export type DeviceCode = {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresInSeconds: number;
    intervalSeconds: number;
};

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_DEVICE_CODE_SECONDS = 900;
const DEFAULT_POLL_SECONDS = 5;

const inFlight = new Map<string, Promise<string>>();

/**
 * An access token for the account, refreshed first when it expires within 5 minutes. One call per account key runs at
 * a time, so two logins asking together share one request and one rotated refresh token is never spent twice.
 */
export function accessTokenFor(request: AccessTokenRequest): Promise<string> {
    const { key } = request.auth;
    const running = inFlight.get(key);
    if (running) return running;
    const started = obtainToken(request).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
}

async function obtainToken(request: AccessTokenRequest): Promise<string> {
    const { auth, secrets, now } = request;
    const secret = (await secrets.read(auth.key)) ?? {};
    if (auth.kind !== "google" && auth.kind !== "microsoft" && auth.kind !== "microsoft_app") {
        throw new Error(`Account ${auth.key} signs in with ${auth.kind}, which has no access token.`);
    }
    if (
        secret.accessToken !== undefined &&
        secret.accessTokenExpiresAt !== undefined &&
        secret.accessTokenExpiresAt - now().getTime() > REFRESH_MARGIN_MS
    ) {
        return secret.accessToken;
    }
    if (auth.kind === "microsoft_app") return fetchAppToken(request, secret);
    return refreshUserToken(request, secret);
}

async function fetchAppToken(request: AccessTokenRequest, secret: AccountSecret): Promise<string> {
    const { auth, scopes, secrets, endpoints, now } = request;
    if (secret.clientSecret === undefined) throw new SignInNeededError(`Account ${auth.key} has no client secret.`);
    const answer = await postToken(auth, microsoftTokenUrl(endpoints.microsoftBase, tenantOf(auth)), {
        client_id: clientIdOf(auth),
        client_secret: secret.clientSecret,
        grant_type: "client_credentials",
        scope: scopes.join(" "),
    });
    return storeToken(secrets, auth.key, secret, answer, now());
}

async function refreshUserToken(request: AccessTokenRequest, secret: AccountSecret): Promise<string> {
    const { auth, scopes, secrets, endpoints, now } = request;
    if (secret.refreshToken === undefined) {
        throw new SignInNeededError(`Account ${auth.key} has no refresh token; sign in again.`);
    }
    const form: Record<string, string> = {
        client_id: clientIdOf(auth),
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
        scope: scopes.join(" "),
    };
    if (secret.clientSecret !== undefined && auth.kind === "google") form.client_secret = secret.clientSecret;
    const url =
        auth.kind === "google" ? endpoints.googleToken : microsoftTokenUrl(endpoints.microsoftBase, tenantOf(auth));
    const answer = await postToken(auth, url, form);
    return storeToken(secrets, auth.key, secret, answer, now());
}

/** Asks Microsoft for a device code; the team member enters `userCode` at `verificationUri`. */
export async function requestDeviceCode(
    auth: AccountAuth,
    scopes: readonly string[],
    endpoints: ProviderEndpoints,
): Promise<DeviceCode> {
    const url = microsoftDeviceCodeUrl(endpoints.microsoftBase, tenantOf(auth));
    const body = await postForm(auth, url, { client_id: clientIdOf(auth), scope: scopes.join(" ") });
    const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri } = body;
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
        throw new Error(`Account ${auth.key}: the device code endpoint's answer lacks a code or an address.`);
    }
    return {
        deviceCode,
        userCode,
        verificationUri,
        expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : DEFAULT_DEVICE_CODE_SECONDS,
        intervalSeconds: typeof body.interval === "number" ? body.interval : DEFAULT_POLL_SECONDS,
    };
}

/** Asks once whether the code was entered. Throws `TokenRefusedError` with `authorization_pending` while it was not. */
export function pollDeviceCode(
    auth: AccountAuth,
    endpoints: ProviderEndpoints,
    deviceCode: string,
): Promise<TokenAnswer> {
    return postToken(auth, microsoftTokenUrl(endpoints.microsoftBase, tenantOf(auth)), {
        client_id: clientIdOf(auth),
        grant_type: DEVICE_CODE_GRANT,
        device_code: deviceCode,
    });
}

/** The address a team member opens to let the account's mail be read, with a fresh PKCE verifier and `state`. */
export function googleAuthorization(
    auth: AccountAuth,
    scopes: readonly string[],
    endpoints: ProviderEndpoints,
    redirectUri: string,
    state: string,
    verifier: string,
): string {
    const query = new URLSearchParams({
        client_id: clientIdOf(auth),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
    });
    return `${endpoints.googleAuthorize}?${query}`;
}

export function newPkceSecret(): string {
    return randomBytes(32).toString("base64url");
}

/** Exchanges the code Google's redirect carried, with the PKCE verifier and the account's client secret. */
export function exchangeAuthorizationCode(
    auth: AccountAuth,
    endpoints: ProviderEndpoints,
    exchange: { code: string; verifier: string; redirectUri: string; clientSecret: string },
): Promise<TokenAnswer> {
    return postToken(auth, endpoints.googleToken, {
        client_id: clientIdOf(auth),
        client_secret: exchange.clientSecret,
        grant_type: "authorization_code",
        code: exchange.code,
        code_verifier: exchange.verifier,
        redirect_uri: exchange.redirectUri,
    });
}

/** Writes the tokens of a finished sign-in, keeping what else the account's secret holds. */
export async function storeSignedIn(secrets: SecretsStore, key: string, answer: TokenAnswer, at: Date): Promise<void> {
    await storeToken(secrets, key, (await secrets.read(key)) ?? {}, answer, at);
}

async function storeToken(
    secrets: SecretsStore,
    key: string,
    secret: AccountSecret,
    answer: TokenAnswer,
    at: Date,
): Promise<string> {
    await secrets.write(key, {
        ...secret,
        accessToken: answer.accessToken,
        accessTokenExpiresAt: at.getTime() + answer.expiresInSeconds * 1000,
        refreshToken: answer.refreshToken ?? secret.refreshToken,
    });
    return answer.accessToken;
}

function clientIdOf(auth: AccountAuth): string {
    if (auth.clientId === undefined) throw new Error(`Account ${auth.key} has no client ID.`);
    return auth.clientId;
}

function tenantOf(auth: AccountAuth): string {
    if (auth.tenant === undefined) throw new Error(`Account ${auth.key} has no tenant.`);
    return auth.tenant;
}

// Messages carry the provider's own words and the status, never the request: the request holds the secrets.
async function postForm(
    auth: AccountAuth,
    url: string,
    form: Record<string, string>,
): Promise<Record<string, unknown>> {
    let response: Response;
    try {
        response = await fetch(url, { method: "POST", body: new URLSearchParams(form) });
    } catch {
        throw new Error(`Account ${auth.key}: the token endpoint could not be reached.`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
        const message = typeof body.error_description === "string" ? body.error_description : String(body.error ?? "");
        const text = message === "" ? `the token endpoint answered ${response.status}` : message;
        if (body.error === "invalid_grant") throw new SignInNeededError(text);
        if (typeof body.error === "string") throw new TokenRefusedError(body.error, `Account ${auth.key}: ${text}`);
        throw new Error(`Account ${auth.key}: ${text}`);
    }
    return body;
}

async function postToken(auth: AccountAuth, url: string, form: Record<string, string>): Promise<TokenAnswer> {
    const body = await postForm(auth, url, form);
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
        throw new Error(`Account ${auth.key}: the token endpoint's answer lacks an access token or its lifetime.`);
    }
    return {
        accessToken: body.access_token,
        expiresInSeconds: body.expires_in,
        ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    };
}
