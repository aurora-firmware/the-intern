/**
 * What the `bob mail` commands print (S-009 REQ-017, REQ-020): a list line, an account's detail, a login check, a
 * sign-in start and the notice settings, from the service's result shapes alone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    formatAccountDetail,
    formatAccountLine,
    formatNotices,
    formatSignInStart,
    formatTestResult,
} from "../../src/cli/mail_text.ts";
import type { MailAccountView } from "../../src/service/mail_operations.ts";

const ESC = String.fromCharCode(27);
const CHECKED_AT = "2026-11-04T10:00:00.000Z";

function account(overrides: Partial<MailAccountView> = {}): MailAccountView {
    return {
        name: "work",
        kind: "owned",
        address: "bob@example.org",
        imapHost: "imap.example.org",
        imapPort: 993,
        imapSecurity: "tls",
        smtpHost: "smtp.example.org",
        smtpPort: 465,
        smtpSecurity: "tls",
        login: "bob",
        auth: "password",
        checkIntervalSeconds: 60,
        triageRole: "triage",
        allow: ["alice@example.org", "@example.com"],
        status: "ready",
        lastCheck: CHECKED_AT,
        ...overrides,
    };
}

describe("the account line of bob mail list", () => {
    it("prints_name_address_kind_status_and_last_check_on_one_line", () => {
        const line = formatAccountLine(account());
        assert.equal(line.split("\n").length, 1);
        for (const part of ["work", "bob@example.org", "owned", "ready", CHECKED_AT]) {
            assert.ok(line.includes(part), `${part} is in ${line}`);
        }
    });

    it("says_never_for_an_account_not_yet_checked", () => {
        const line = formatAccountLine(account({ lastCheck: undefined, status: "connecting" }));
        assert.ok(line.includes("connecting"));
        assert.ok(line.includes("never"));
    });

    it("keeps_a_name_with_a_line_break_and_an_escape_on_one_clean_line", () => {
        const line = formatAccountLine(account({ name: `a\nb${ESC}]52;c;ZXZpbA==\u0007` }));
        assert.equal(line.split("\n").length, 1);
        assert.ok(!line.includes(ESC));
    });
});

describe("the detail of bob mail show", () => {
    it("prints_settings_allowlist_triage_role_status_and_last_error", () => {
        const text = formatAccountDetail(
            account({ status: "failing", lastError: { message: "login refused", at: CHECKED_AT } }),
        );
        for (const part of [
            "work",
            "bob@example.org",
            "imap.example.org",
            "993",
            "smtp.example.org",
            "465",
            "bob",
            "password",
            "60",
            "alice@example.org",
            "@example.com",
            "triage",
            "failing",
            "login refused",
            CHECKED_AT,
        ]) {
            assert.ok(text.includes(part), `${part} is in ${text}`);
        }
    });

    it("prints_no_last_error_line_value_when_the_account_has_none", () => {
        const text = formatAccountDetail(account());
        assert.ok(text.includes("Last error: (none)"));
    });

    it("prints_the_password_command_of_a_password_command_account_but_never_a_secret", () => {
        const text = formatAccountDetail(
            account({ auth: "password_command", passwordCommand: ["pass", "show", "work"] }),
        );
        assert.ok(text.includes("pass show work"));
        const leaking = { ...account(), password: "hunter2", clientSecret: "s3cret" } as MailAccountView;
        const leaked = formatAccountDetail(leaking);
        assert.ok(!leaked.includes("hunter2"));
        assert.ok(!leaked.includes("s3cret"));
    });

    it("prints_none_for_an_empty_allowlist_and_no_triage_role", () => {
        const text = formatAccountDetail(account({ allow: [], triageRole: undefined }));
        assert.ok(text.includes("Allowlist: (none)"));
        assert.ok(text.includes("Triage role: (none)"));
    });

    it("keeps_an_error_message_with_an_escape_free_of_control_sequences", () => {
        const text = formatAccountDetail(
            account({ lastError: { message: `bad${ESC}[2Jnews\nFake: line`, at: CHECKED_AT } }),
        );
        assert.ok(!text.includes(ESC));
        assert.ok(!text.split("\n").includes("Fake: line"));
    });
});

describe("the sign-in start", () => {
    it("prints_the_microsoft_code_and_address", () => {
        const text = formatSignInStart({
            kind: "device_code",
            code: "ABCD-1234",
            address: "https://example.org/device",
        });
        assert.ok(text.includes("ABCD-1234"));
        assert.ok(text.includes("https://example.org/device"));
    });

    it("prints_the_google_address_to_open_and_the_port_to_forward", () => {
        const text = formatSignInStart({
            kind: "browser",
            address: "https://accounts.example.org/auth?x=1",
            port: 38123,
        });
        assert.ok(text.includes("https://accounts.example.org/auth?x=1"));
        assert.ok(text.includes("38123"));
    });
});

describe("the login check result", () => {
    it("prints_imap_and_smtp_as_ok", () => {
        const text = formatTestResult({ imap: { ok: true }, smtp: { ok: true } });
        assert.ok(text.includes("IMAP: ok"));
        assert.ok(text.includes("SMTP: ok"));
    });

    it("prints_the_servers_words_when_a_login_is_refused", () => {
        const text = formatTestResult({ imap: { ok: false, message: "AUTHENTICATIONFAILED" } });
        assert.ok(text.includes("IMAP: failed - AUTHENTICATIONFAILED"));
        assert.ok(!text.includes("SMTP"));
    });
});

describe("the notice settings", () => {
    it("prints_the_to_and_from_accounts", () => {
        const text = formatNotices({ to: "bob@example.org", from: "work" });
        assert.ok(text.includes("To: bob@example.org"));
        assert.ok(text.includes("From: work"));
    });

    it("prints_none_for_an_unset_notice", () => {
        assert.equal(formatNotices({}), "To: (none)\nFrom: (none)");
    });
});
