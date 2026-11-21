/**
 * The text the `bob mail` commands print (S-009 REQ-017, REQ-020). Pure: each function turns a service answer into
 * text. A detail is built field by field from `MailAccountView`, which has no field for a secret, so none can reach the
 * output. Every value goes through `terminal_text.ts`: the values of an account come from the configuration file and a
 * server's words from the network. Imports types only, never the daemon.
 */
import type { SignInStart } from "../accounts/sign_in.ts";
import type { MailAccountView, MailNoticeView, MailTestResult, ServerCheck } from "../service/mail_operations.ts";
import { continued, flat } from "./terminal_text.ts";

const NOTHING = "(none)";
const NEVER = "never";

/** One line: name, address, kind, status and last check. */
export function formatAccountLine(account: MailAccountView): string {
    const lastCheck = account.lastCheck === undefined ? NEVER : flat(account.lastCheck);
    return `${flat(account.name)}  ${flat(account.address)}  ${account.kind}  ${account.status}  checked ${lastCheck}`;
}

function endpointText(host: string | undefined, port: number | undefined, security: string): string {
    return host === undefined || port === undefined ? NOTHING : `${flat(host)}:${port} (${security})`;
}

function lastErrorText(account: MailAccountView): string {
    if (account.lastError === undefined) return NOTHING;
    return `${continued(account.lastError.message)} (${flat(account.lastError.at)})`;
}

/** The account's settings, allowlist, triage role, status and last error, one per line. */
export function formatAccountDetail(account: MailAccountView): string {
    const lines = [
        flat(account.name),
        `Address: ${flat(account.address)}`,
        `Kind: ${account.kind}`,
        `IMAP: ${endpointText(account.imapHost, account.imapPort, account.imapSecurity)}`,
        `SMTP: ${endpointText(account.smtpHost, account.smtpPort, account.smtpSecurity)}`,
        `Login: ${flat(account.login)}`,
        `Authentication: ${account.auth}`,
    ];
    if (account.passwordCommand !== undefined) {
        lines.push(`Password command: ${account.passwordCommand.map(flat).join(" ")}`);
    }
    if (account.clientId !== undefined) lines.push(`Client id: ${flat(account.clientId)}`);
    if (account.tenant !== undefined) lines.push(`Tenant: ${flat(account.tenant)}`);
    lines.push(
        `Check interval: ${account.checkIntervalSeconds} seconds`,
        `Allowlist: ${account.allow.length === 0 ? NOTHING : account.allow.map(flat).join(", ")}`,
        `Triage role: ${account.triageRole === undefined ? NOTHING : flat(account.triageRole)}`,
        `Status: ${account.status}`,
        `Last check: ${account.lastCheck === undefined ? NEVER : flat(account.lastCheck)}`,
        `Last error: ${lastErrorText(account)}`,
    );
    return lines.join("\n");
}

function checkText(label: string, check: ServerCheck): string {
    if (check.ok) return `${label}: ok`;
    return check.message === undefined ? `${label}: failed` : `${label}: failed - ${continued(check.message)}`;
}

/** One line per server checked. */
export function formatTestResult(result: MailTestResult): string {
    const lines = [checkText("IMAP", result.imap)];
    if (result.smtp !== undefined) lines.push(checkText("SMTP", result.smtp));
    return lines.join("\n");
}

/** What a team member does next: enter the code at the address, or open the address and forward the port. */
export function formatSignInStart(start: SignInStart): string {
    if (start.kind === "device_code") {
        return `Open ${flat(start.address)} and enter the code ${flat(start.code)}.`;
    }
    return `Open ${flat(start.address)} in a browser. On another machine, forward port ${start.port} to this one first.`;
}

/** The addresses mail notices go to and come from. */
export function formatNotices(notices: MailNoticeView): string {
    const value = (text: string | undefined) => (text === undefined ? NOTHING : flat(text));
    return `To: ${value(notices.to)}\nFrom: ${value(notices.from)}`;
}
