import { ConfigValueError, defineConfigSection } from "../config/config_file.ts";
import { type MailAccount, type MailNotice, MailRuleError, validateMailAccount } from "./mail_model.ts";

const ACCOUNT_KEYS: readonly string[] = [
    "name",
    "kind",
    "address",
    "imap_host",
    "imap_port",
    "imap_security",
    "smtp_host",
    "smtp_port",
    "smtp_security",
    "login",
    "auth",
    "password_command",
    "client_id",
    "tenant",
    "check_interval_seconds",
    "triage_role",
    "allow",
];
const NOTICE_KEYS: readonly string[] = ["notice_to", "notice_from"];

const isTable = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const refuseUnknownKey = (table: Record<string, unknown>, known: readonly string[], prefix: string): void => {
    const unknown = Object.keys(table).find((key) => !known.includes(key));
    if (unknown !== undefined) throw new ConfigValueError(`${prefix}${unknown}`, "is not a mail setting");
};

const parseAccount = (raw: unknown, position: number, seen: Set<string>): MailAccount => {
    if (!isTable(raw)) throw new ConfigValueError(String(position), "must be a table");
    const label = typeof raw.name === "string" && raw.name !== "" ? raw.name : String(position);
    refuseUnknownKey(raw, ACCOUNT_KEYS, `${label}.`);
    let account: MailAccount;
    try {
        account = validateMailAccount(raw, label);
    } catch (error) {
        if (!(error instanceof MailRuleError)) throw error;
        throw new ConfigValueError(`${label}.${error.key}`, error.reason.replace(`${label}: `, ""));
    }
    if (seen.has(account.name)) throw new ConfigValueError(`${account.name}.name`, "is used by another account");
    seen.add(account.name);
    return account;
};

const serializeAccount = (account: MailAccount): Record<string, unknown> => {
    const table: Record<string, unknown> = {
        name: account.name,
        kind: account.kind,
        address: account.address,
        imap_host: account.imapHost,
        imap_port: account.imapPort,
        imap_security: account.imapSecurity,
    };
    if (account.smtpHost !== undefined) table.smtp_host = account.smtpHost;
    if (account.smtpPort !== undefined) table.smtp_port = account.smtpPort;
    table.smtp_security = account.smtpSecurity;
    table.login = account.login;
    table.auth = account.auth;
    if (account.passwordCommand !== undefined) table.password_command = account.passwordCommand;
    if (account.clientId !== undefined) table.client_id = account.clientId;
    if (account.tenant !== undefined) table.tenant = account.tenant;
    table.check_interval_seconds = account.checkIntervalSeconds;
    if (account.triageRole !== undefined) {
        table.triage_role = account.triageRole;
        table.allow = account.allow;
    }
    return table;
};

export const mailAccountSection = defineConfigSection<MailAccount[]>({
    name: "mail_account",
    defaults: () => [],
    parse(table) {
        if (!Array.isArray(table)) {
            throw new ConfigValueError("mail_account", "must be a list of [[mail_account]] tables");
        }
        const seen = new Set<string>();
        return table.map((raw, index) => parseAccount(raw, index + 1, seen));
    },
    serialize: (accounts) => accounts.map(serializeAccount),
});

const noticeText = (table: Record<string, unknown>, key: string): string => {
    const value = table[key];
    if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigValueError(key, "must be a non-empty string");
    }
    return value;
};

export const mailSection = defineConfigSection<MailNotice | undefined>({
    name: "mail",
    defaults: () => undefined,
    parse(table) {
        if (!isTable(table)) throw new ConfigValueError("mail", "must be a table");
        refuseUnknownKey(table, NOTICE_KEYS, "");
        const given = NOTICE_KEYS.filter((key) => table[key] !== undefined);
        if (given.length === 0) return undefined;
        return { to: noticeText(table, "notice_to"), from: noticeText(table, "notice_from") };
    },
    serialize: (notice) => (notice === undefined ? {} : { notice_to: notice.to, notice_from: notice.from }),
});
