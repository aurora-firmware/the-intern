/** The types the accounts layer shares, and the addresses of the providers' OAuth 2.0 endpoints. */

export type AccountAuthKind = "password" | "password_command" | "google" | "microsoft" | "microsoft_app";

export type AccountAuth = {
    /** The account's key in the secrets store, `<owner>/<name>`. */
    key: string;
    kind: AccountAuthKind;
    login: string;
    clientId?: string;
    tenant?: string;
    passwordCommand?: string[];
};

/** What a login uses to authenticate: a password, or an OAuth access token for SASL XOAUTH2. */
export type Credential = { user: string; password: string } | { user: string; accessToken: string };

export type ProviderEndpoints = {
    /** `https://login.microsoftonline.com`; the tenant and the `oauth2/v2.0/...` path follow it. */
    microsoftBase: string;
    googleAuthorize: string;
    googleToken: string;
};

export const REAL_PROVIDER_ENDPOINTS: ProviderEndpoints = {
    microsoftBase: "https://login.microsoftonline.com",
    googleAuthorize: "https://accounts.google.com/o/oauth2/v2/auth",
    googleToken: "https://oauth2.googleapis.com/token",
};

export function microsoftDeviceCodeUrl(microsoftBase: string, tenant: string): string {
    return `${microsoftBase}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`;
}

export function microsoftTokenUrl(microsoftBase: string, tenant: string): string {
    return `${microsoftBase}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}
