/**
 * The Mail page's decision logic (S-009 REQ-018): the accounts and notice settings it holds, how a status delta from
 * the instance feed changes them, when the feed makes the page read them again, and how the form becomes the input of
 * `mail.accounts.create` and `mail.accounts.change`. It imports nothing, so Node tests it without a DOM. A secret field
 * is never filled from the service: `formFor` and `emptyForm` leave it empty, and `clearSecret` empties it after a call.
 */

export type MailAuth = "password" | "password_command" | "google" | "microsoft" | "microsoft_app";
export type MailStatus = "connecting" | "ready" | "failing" | "needs_sign_in";

/** An account as `mail.accounts.list` returns it: its settings and its status, with no secret. */
export type MailAccountView = {
    name: string;
    kind: "owned" | "monitored";
    address: string;
    imapHost: string;
    imapPort: number;
    imapSecurity: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecurity: string;
    login: string;
    auth: MailAuth;
    passwordCommand?: string[];
    clientId?: string;
    tenant?: string;
    checkIntervalSeconds: number;
    triageRole?: string;
    allow: string[];
    status: MailStatus;
    lastError?: { message: string; at: string };
    lastCheck?: string;
};

export type MailNoticeView = { to?: string; from?: string };

export type MailState = { accounts: MailAccountView[]; notice: MailNoticeView };

/** The deltas the page looks at. Declared here so the page imports no daemon type. */
export type MailStatusDelta = {
    type: "mail_account_status";
    name: string;
    status: MailStatus;
    lastError?: { message: string; at: string };
    lastCheck?: string;
};
export type MailDelta = MailStatusDelta | { type: string; section?: string };

/** The mail sections of the settings file; a change of either makes the page read again. */
const MAIL_SECTIONS: readonly string[] = ["mail", "mail_account"];

/** Sets the named account's status, last error and last check from the delta, which carries all three. */
export const applyStatusDelta = (state: MailState, delta: MailStatusDelta): MailState => {
    if (!state.accounts.some((account) => account.name === delta.name)) {
        return state;
    }
    const accounts = state.accounts.map((account): MailAccountView => {
        if (account.name !== delta.name) {
            return account;
        }
        const { lastError: _error, lastCheck: _check, ...rest } = account;
        return {
            ...rest,
            status: delta.status,
            ...(delta.lastError && { lastError: delta.lastError }),
            ...(delta.lastCheck && { lastCheck: delta.lastCheck }),
        };
    });
    return { ...state, accounts };
};

/** Whether the delta is a settings change of a mail section, after which the page reads accounts and notice again. */
export const needsReload = (delta: MailDelta): boolean =>
    delta.type === "settings_changed" && delta.section !== undefined && MAIL_SECTIONS.includes(delta.section);

/** The form's fields, all text as typed. `allow` and `passwordCommand` hold one entry per line or comma. */
export type MailForm = {
    name: string;
    kind: string;
    address: string;
    imapHost: string;
    imapPort: string;
    imapSecurity: string;
    smtpHost: string;
    smtpPort: string;
    smtpSecurity: string;
    login: string;
    auth: string;
    passwordCommand: string;
    clientId: string;
    tenant: string;
    checkIntervalSeconds: string;
    triageRole: string;
    allow: string;
    password: string;
    clientSecret: string;
};

type SecretField = "password" | "clientSecret";
type AuthField = SecretField | "passwordCommand" | "clientId" | "tenant";

const SECRET_FIELDS: readonly SecretField[] = ["password", "clientSecret"];

const FIELDS_BY_AUTH: Record<string, readonly AuthField[]> = {
    password: ["password"],
    password_command: ["passwordCommand"],
    google: ["clientId", "clientSecret"],
    microsoft: ["clientId", "tenant"],
    microsoft_app: ["clientId", "tenant", "clientSecret"],
};

/** The auth-specific fields an `auth` kind needs; an unknown kind needs none. */
export const fieldsFor = (auth: string): readonly AuthField[] => FIELDS_BY_AUTH[auth] ?? [];

export const emptyForm = (): MailForm => ({
    name: "",
    kind: "owned",
    address: "",
    imapHost: "",
    imapPort: "",
    imapSecurity: "",
    smtpHost: "",
    smtpPort: "",
    smtpSecurity: "",
    login: "",
    auth: "password",
    passwordCommand: "",
    clientId: "",
    tenant: "",
    checkIntervalSeconds: "",
    triageRole: "",
    allow: "",
    password: "",
    clientSecret: "",
});

/** The form of an existing account, with both secret fields empty. */
export const formFor = (account: MailAccountView): MailForm => ({
    name: account.name,
    kind: account.kind,
    address: account.address,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapSecurity: account.imapSecurity,
    smtpHost: account.smtpHost ?? "",
    smtpPort: account.smtpPort === undefined ? "" : String(account.smtpPort),
    smtpSecurity: account.smtpSecurity,
    login: account.login,
    auth: account.auth,
    passwordCommand: (account.passwordCommand ?? []).join("\n"),
    clientId: account.clientId ?? "",
    tenant: account.tenant ?? "",
    checkIntervalSeconds: String(account.checkIntervalSeconds),
    triageRole: account.triageRole ?? "",
    allow: account.allow.join("\n"),
    password: "",
    clientSecret: "",
});

/** The form after a call: every secret field empty, the rest as it was. */
export const clearSecret = (form: MailForm): MailForm => ({ ...form, password: "", clientSecret: "" });

const splitList = (text: string): string[] =>
    text
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");

type Setting = { key: string; field: keyof MailForm; read: (text: string) => unknown };

const asText = (text: string): string => text.trim();
const asNumber = (text: string): number => Number(text.trim());

const SETTINGS: readonly Setting[] = [
    { key: "kind", field: "kind", read: asText },
    { key: "address", field: "address", read: asText },
    { key: "imap_host", field: "imapHost", read: asText },
    { key: "imap_port", field: "imapPort", read: asNumber },
    { key: "imap_security", field: "imapSecurity", read: asText },
    { key: "smtp_host", field: "smtpHost", read: asText },
    { key: "smtp_port", field: "smtpPort", read: asNumber },
    { key: "smtp_security", field: "smtpSecurity", read: asText },
    { key: "login", field: "login", read: asText },
    { key: "auth", field: "auth", read: asText },
    { key: "password_command", field: "passwordCommand", read: splitList },
    { key: "client_id", field: "clientId", read: asText },
    { key: "tenant", field: "tenant", read: asText },
    { key: "check_interval_seconds", field: "checkIntervalSeconds", read: asNumber },
    { key: "triage_role", field: "triageRole", read: asText },
    { key: "allow", field: "allow", read: splitList },
];

const isEmptyValue = (value: unknown): boolean => value === "" || (Array.isArray(value) && value.length === 0);

/** The secrets the form's auth kind keeps, only for a field that is filled. */
const secretsOf = (form: MailForm): Partial<Record<SecretField, string>> => {
    const kept = fieldsFor(form.auth);
    const secrets: Partial<Record<SecretField, string>> = {};
    for (const field of SECRET_FIELDS) {
        if (kept.includes(field) && form[field] !== "") {
            secrets[field] = form[field];
        }
    }
    return secrets;
};

/** The input of `mail.accounts.create`: each filled setting under its operation key, and a secret only when filled. */
export const createInput = (form: MailForm): Record<string, unknown> => {
    const input: Record<string, unknown> = { name: form.name.trim() };
    for (const { key, field, read } of SETTINGS) {
        const value = read(form[field]);
        if (!isEmptyValue(value)) {
            input[key] = value;
        }
    }
    return { ...input, ...secretsOf(form) };
};

/**
 * The input of `mail.accounts.change`: the name, each setting that differs from the account (`null` where the form
 * emptied one), and a secret only when filled.
 */
export const changeInput = (account: MailAccountView, form: MailForm): Record<string, unknown> => {
    const held = formFor(account);
    const input: Record<string, unknown> = { name: account.name };
    for (const { key, field, read } of SETTINGS) {
        const value = read(form[field]);
        if (JSON.stringify(value) === JSON.stringify(read(held[field]))) {
            continue;
        }
        input[key] = isEmptyValue(value) ? null : value;
    }
    return { ...input, ...secretsOf(form) };
};
