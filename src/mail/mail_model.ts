export type MailKind = "owned" | "monitored";
export type MailSecurity = "tls" | "starttls" | "none";
export type MailAuth = "password" | "password_command" | "google" | "microsoft" | "microsoft_app";

export type MailAccount = {
    name: string;
    kind: MailKind;
    address: string;
    imapHost: string;
    imapPort: number;
    imapSecurity: MailSecurity;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecurity: MailSecurity;
    login: string;
    auth: MailAuth;
    passwordCommand?: string[];
    clientId?: string;
    tenant?: string;
    checkIntervalSeconds: number;
    triageRole?: string;
    allow: string[];
};

export type MailNotice = { to: string; from: string };

export class MailRuleError extends Error {
    readonly key: string;
    readonly reason: string;

    constructor(key: string, reason: string) {
        super(`${key}: ${reason}`);
        this.name = "MailRuleError";
        this.key = key;
        this.reason = reason;
    }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ADDRESS_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+$/;
const DOMAIN_ENTRY_PATTERN = /^@[^\s@,;<>]+$/;
const KINDS: readonly string[] = ["owned", "monitored"];
const SECURITIES: readonly string[] = ["tls", "starttls", "none"];
const AUTHS: readonly string[] = ["password", "password_command", "google", "microsoft", "microsoft_app"];
const TENANT_ALIASES: readonly string[] = ["organizations", "consumers", "common"];
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TRIAGE_ROLE = "triage";

type Raw = Record<string, unknown>;

export const accountKey = (name: string): string => `mail/${name}`;

const refuse = (label: string, key: string, reason: string): never => {
    throw new MailRuleError(key, `${label}: ${reason}`);
};

const requiredString = (raw: Raw, key: string, label: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") {
        return refuse(label, key, "is required and must be a non-empty string");
    }
    return value;
};

const optionalString = (raw: Raw, key: string, label: string): string | undefined => {
    if (raw[key] === undefined) {
        return undefined;
    }
    return requiredString(raw, key, label);
};

const oneOf = (raw: Raw, key: string, label: string, allowed: readonly string[], fallback?: string): string => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "string" || !allowed.includes(value)) {
        return refuse(label, key, `must be one of ${allowed.join(", ")}`);
    }
    return value;
};

const port = (raw: Raw, key: string, label: string, fallback: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
        return refuse(label, key, "must be a whole number from 1 to 65535");
    }
    return value;
};

const defaultPort = (security: string, tlsPort: number, plainPort: number): number =>
    security === "tls" ? tlsPort : plainPort;

const interval = (raw: Raw, label: string): number => {
    const value = raw.check_interval_seconds ?? DEFAULT_INTERVAL_SECONDS;
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < MIN_INTERVAL_SECONDS ||
        value > MAX_INTERVAL_SECONDS
    ) {
        return refuse(
            label,
            "check_interval_seconds",
            `must be a whole number from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`,
        );
    }
    return value;
};

const allowList = (raw: Raw, label: string): string[] => {
    const value = raw.allow ?? [];
    if (!Array.isArray(value)) {
        return refuse(label, "allow", "must be a list of addresses and @domain entries");
    }
    for (const entry of value) {
        if (typeof entry !== "string" || !(ADDRESS_PATTERN.test(entry) || DOMAIN_ENTRY_PATTERN.test(entry))) {
            refuse(label, "allow", `entry ${JSON.stringify(entry)} is not an address or an @domain`);
        }
    }
    return value as string[];
};

const ownedOnly = (raw: Raw, key: string, label: string): void => {
    if (raw[key] !== undefined) {
        refuse(label, key, "is for owned accounts only");
    }
};

const passwordCommand = (raw: Raw, auth: string, label: string): string[] | undefined => {
    const value = raw.password_command;
    if (auth !== "password_command") {
        if (value !== undefined) {
            refuse(label, "password_command", "is allowed with auth password_command only");
        }
        return undefined;
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part === "")) {
        return refuse(label, "password_command", "is required with auth password_command: a non-empty command list");
    }
    return value as string[];
};

const tenantFor = (raw: Raw, auth: string, label: string): string | undefined => {
    if (auth !== "microsoft" && auth !== "microsoft_app") {
        return undefined;
    }
    const tenant = requiredString(raw, "tenant", label);
    if (auth === "microsoft_app" && TENANT_ALIASES.includes(tenant)) {
        refuse(label, "tenant", "must be a tenant ID with auth microsoft_app");
    }
    return tenant;
};

const clientIdFor = (raw: Raw, auth: string, label: string): string | undefined =>
    auth === "google" || auth === "microsoft" || auth === "microsoft_app"
        ? requiredString(raw, "client_id", label)
        : optionalString(raw, "client_id", label);

export const validateMailAccount = (raw: Raw, label: string): MailAccount => {
    const name = requiredString(raw, "name", label);
    if (!NAME_PATTERN.test(name)) {
        refuse(label, "name", "must be 1 to 64 letters, digits and hyphens, starting with a letter or digit");
    }
    const kind = oneOf(raw, "kind", label, KINDS) as MailKind;
    const address = requiredString(raw, "address", label);
    if (!ADDRESS_PATTERN.test(address)) {
        refuse(label, "address", "must be one email address");
    }
    const imapSecurity = oneOf(raw, "imap_security", label, SECURITIES, "tls") as MailSecurity;
    const smtpSecurity = oneOf(raw, "smtp_security", label, SECURITIES, "tls") as MailSecurity;
    const auth = oneOf(raw, "auth", label, AUTHS) as MailAuth;
    const account: MailAccount = {
        name,
        kind,
        address,
        imapHost: requiredString(raw, "imap_host", label),
        imapPort: port(raw, "imap_port", label, defaultPort(imapSecurity, 993, 143)),
        imapSecurity,
        smtpSecurity,
        login: optionalString(raw, "login", label) ?? address,
        auth,
        checkIntervalSeconds: interval(raw, label),
        allow: [],
    };
    const command = passwordCommand(raw, auth, label);
    if (command) {
        account.passwordCommand = command;
    }
    const clientId = clientIdFor(raw, auth, label);
    if (clientId) {
        account.clientId = clientId;
    }
    const tenant = tenantFor(raw, auth, label);
    if (tenant) {
        account.tenant = tenant;
    }
    if (kind === "monitored") {
        ownedOnly(raw, "smtp_host", label);
        ownedOnly(raw, "triage_role", label);
        ownedOnly(raw, "allow", label);
        return account;
    }
    const smtpHost = optionalString(raw, "smtp_host", label);
    if (smtpHost) {
        account.smtpHost = smtpHost;
        account.smtpPort = port(raw, "smtp_port", label, defaultPort(smtpSecurity, 465, 587));
    }
    account.triageRole = optionalString(raw, "triage_role", label) ?? DEFAULT_TRIAGE_ROLE;
    account.allow = allowList(raw, label);
    return account;
};

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const isAllowed = (allow: string[], address: string): boolean => {
    if (allow.length === 0) {
        return true;
    }
    const lowered = address.toLowerCase();
    const domain = lowered.slice(lowered.lastIndexOf("@"));
    return allow.some((entry) => {
        const wanted = entry.toLowerCase();
        return wanted.startsWith("@") ? wanted === domain : wanted === lowered;
    });
};

export const notAllowedRecipients = (
    account: MailAccount,
    recipients: string[],
    noticeTo: string | undefined,
): string[] =>
    recipients.filter(
        (recipient) =>
            !(noticeTo !== undefined && sameAddress(recipient, noticeTo)) && !isAllowed(account.allow, recipient),
    );

export const checkNotice = (notice: MailNotice, accounts: MailAccount[]): void => {
    if (accounts.some((account) => account.kind === "owned" && sameAddress(account.address, notice.to))) {
        throw new MailRuleError("notice_to", `${notice.to} is the address of an owned account`);
    }
    const sender = accounts.find((account) => account.name === notice.from);
    if (sender?.kind !== "owned" || sender.smtpHost === undefined) {
        throw new MailRuleError("notice_from", `${notice.from} is not an owned account with an SMTP host`);
    }
};
