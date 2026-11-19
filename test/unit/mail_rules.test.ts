import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MailRuleError, validateMailAccount } from "../../src/mail/mail_model.ts";

const validOwned = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "intern",
    kind: "owned",
    address: "intern@example.com",
    imap_host: "imap.example.com",
    smtp_host: "smtp.example.com",
    auth: "password",
    ...overrides,
});

const refusedKey = (raw: Record<string, unknown>): string => {
    try {
        validateMailAccount(raw, "intern");
    } catch (error) {
        assert.ok(error instanceof MailRuleError);
        return error.key;
    }
    throw new Error("expected MailRuleError");
};

describe("validateMailAccount refusals", () => {
    const cases: [string, Record<string, unknown>, string][] = [
        ["a name with a space", validOwned({ name: "my box" }), "name"],
        ["a name starting with a hyphen", validOwned({ name: "-box" }), "name"],
        ["a name over 64 characters", validOwned({ name: "a".repeat(65) }), "name"],
        ["kind shared", validOwned({ kind: "shared" }), "kind"],
        ["two addresses", validOwned({ address: "a@example.com, b@example.com" }), "address"],
        ["an SMTP host on a monitored account", validOwned({ kind: "monitored" }), "smtp_host"],
        ["google without client_id", validOwned({ auth: "google" }), "client_id"],
        ["password_command without a command", validOwned({ auth: "password_command" }), "password_command"],
        ["password_command with another auth", validOwned({ password_command: ["pass"] }), "password_command"],
        ["microsoft without a tenant", validOwned({ auth: "microsoft", client_id: "c" }), "tenant"],
        [
            "microsoft_app with a tenant alias",
            validOwned({ auth: "microsoft_app", client_id: "c", tenant: "common" }),
            "tenant",
        ],
        ["a check interval of 5", validOwned({ check_interval_seconds: 5 }), "check_interval_seconds"],
        ["a check interval of 3601", validOwned({ check_interval_seconds: 3601 }), "check_interval_seconds"],
        ["a fractional check interval", validOwned({ check_interval_seconds: 10.5 }), "check_interval_seconds"],
        ["an IMAP port of 0", validOwned({ imap_port: 0 }), "imap_port"],
        ["an SMTP port of 65536", validOwned({ smtp_port: 65536 }), "smtp_port"],
        ["an unknown security", validOwned({ imap_security: "ssl" }), "imap_security"],
        ["an allow entry without an at sign", validOwned({ allow: ["example"] }), "allow"],
        ["allow on a monitored account", validOwned({ kind: "monitored", smtp_host: undefined, allow: [] }), "allow"],
        [
            "triage_role on a monitored account",
            validOwned({ kind: "monitored", smtp_host: undefined, triage_role: "triage" }),
            "triage_role",
        ],
    ];
    for (const [name, raw, key] of cases) {
        it(`refuses ${name} naming ${key}`, () => {
            assert.equal(refusedKey(raw), key);
        });
    }
});

describe("validateMailAccount defaults", () => {
    it("applies the ports, security, login, interval and triage role", () => {
        const account = validateMailAccount(validOwned(), "intern");
        assert.equal(account.imapPort, 993);
        assert.equal(account.smtpPort, 465);
        assert.equal(account.imapSecurity, "tls");
        assert.equal(account.smtpSecurity, "tls");
        assert.equal(account.login, "intern@example.com");
        assert.equal(account.checkIntervalSeconds, 60);
        assert.equal(account.triageRole, "triage");
        assert.deepEqual(account.allow, []);
    });

    it("defaults the ports to 143 and 587 without TLS", () => {
        const account = validateMailAccount(validOwned({ imap_security: "starttls", smtp_security: "none" }), "intern");
        assert.equal(account.imapPort, 143);
        assert.equal(account.smtpPort, 587);
    });

    it("gives a monitored account no triage role and no SMTP values", () => {
        const account = validateMailAccount(validOwned({ kind: "monitored", smtp_host: undefined }), "intern");
        assert.equal(account.triageRole, undefined);
        assert.equal(account.smtpHost, undefined);
        assert.equal(account.smtpPort, undefined);
    });

    it("keeps the values a team member set", () => {
        const account = validateMailAccount(
            validOwned({
                imap_port: 1993,
                login: "ana",
                check_interval_seconds: 10,
                triage_role: "sorter",
                allow: ["ana@example.com"],
                auth: "microsoft",
                client_id: "c",
                tenant: "common",
            }),
            "intern",
        );
        assert.equal(account.imapPort, 1993);
        assert.equal(account.login, "ana");
        assert.equal(account.checkIntervalSeconds, 10);
        assert.equal(account.triageRole, "sorter");
        assert.deepEqual(account.allow, ["ana@example.com"]);
        assert.equal(account.tenant, "common");
    });
});
