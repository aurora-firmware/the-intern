/** The Mail page's pure model (S-009 REQ-018): status deltas, reloads, the form turned into operation input, secrets. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    applyStatusDelta,
    changeInput,
    clearSecret,
    createInput,
    emptyForm,
    fieldsFor,
    formFor,
    type MailAccountView,
    type MailForm,
    type MailStatusDelta,
    needsReload,
} from "../../web/ui/model/mail.ts";

const account = (name: string, extra: Partial<MailAccountView> = {}): MailAccountView => ({
    name,
    kind: "owned",
    address: `${name}@example.com`,
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    login: `${name}@example.com`,
    auth: "password",
    checkIntervalSeconds: 300,
    triageRole: "triage",
    allow: ["boss@example.com"],
    status: "ready",
    ...extra,
});

const statusDelta = (name: string, extra: Partial<MailStatusDelta> = {}): MailStatusDelta => ({
    type: "mail_account_status",
    name,
    status: "failing",
    ...extra,
});

const filled = (extra: Partial<MailForm> = {}): MailForm => ({
    ...emptyForm(),
    name: "work",
    kind: "owned",
    address: "work@example.com",
    imapHost: "imap.example.com",
    imapPort: "993",
    imapSecurity: "tls",
    login: "work@example.com",
    auth: "password",
    ...extra,
});

describe("applyStatusDelta", () => {
    it("updates the status, last error and last check of the named account only", () => {
        const state = { accounts: [account("a"), account("b")], notice: {} };
        const lastError = { message: "refused", at: "2026-11-20T10:00:00.000Z" };
        const next = applyStatusDelta(state, statusDelta("b", { lastError, lastCheck: "2026-11-20T10:01:00.000Z" }));
        assert.deepEqual(next.accounts[0], account("a"));
        assert.equal(next.accounts[1]?.status, "failing");
        assert.deepEqual(next.accounts[1]?.lastError, lastError);
        assert.equal(next.accounts[1]?.lastCheck, "2026-11-20T10:01:00.000Z");
    });

    it("drops a last error the delta no longer carries", () => {
        const held = account("a", { lastError: { message: "old", at: "2026-11-20T09:00:00.000Z" } });
        const next = applyStatusDelta({ accounts: [held], notice: {} }, statusDelta("a", { status: "ready" }));
        assert.equal("lastError" in (next.accounts[0] as object), false);
    });

    it("leaves the state alone for an account it does not hold", () => {
        const state = { accounts: [account("a")], notice: {} };
        assert.deepEqual(applyStatusDelta(state, statusDelta("zzz")), state);
    });
});

describe("needsReload", () => {
    it("is true for a settings change of the mail sections", () => {
        assert.equal(needsReload({ type: "settings_changed", section: "mail" }), true);
        assert.equal(needsReload({ type: "settings_changed", section: "mail_account" }), true);
    });

    it("is false for another section and for another delta", () => {
        assert.equal(needsReload({ type: "settings_changed", section: "schedule" }), false);
        assert.equal(needsReload(statusDelta("a")), false);
    });
});

describe("createInput", () => {
    it("sends the secret only when the field is filled", () => {
        assert.equal("password" in createInput(filled()), false);
        assert.equal(createInput(filled({ password: "hunter2" })).password, "hunter2");
    });

    it("sends the allowlist as a list", () => {
        const input = createInput(
            filled({ triageRole: "triage", allow: "a@example.com, @example.org\n\nb@example.com" }),
        );
        assert.deepEqual(input.allow, ["a@example.com", "@example.org", "b@example.com"]);
    });

    it("keys the settings as the operation does and turns numbers into numbers", () => {
        const input = createInput(filled());
        assert.equal(input.imap_host, "imap.example.com");
        assert.equal(input.imap_port, 993);
        assert.equal("smtp_host" in input, false);
    });

    it("sends the password command as a list of words", () => {
        const input = createInput(filled({ auth: "password_command", passwordCommand: "pass\nshow\nwork" }));
        assert.deepEqual(input.password_command, ["pass", "show", "work"]);
    });

    it("leaves out a secret the auth kind does not keep", () => {
        const input = createInput(filled({ auth: "password_command", passwordCommand: "x", password: "stale" }));
        assert.equal("password" in input, false);
    });
});

describe("changeInput", () => {
    it("sends the name and only the settings that differ", () => {
        const form = { ...formFor(account("work")), imapHost: "imap.other.com" };
        assert.deepEqual(changeInput(account("work"), form), { name: "work", imap_host: "imap.other.com" });
    });

    it("sends a new allowlist as a list and null for an emptied optional setting", () => {
        const form = { ...formFor(account("work")), allow: "x@example.com", smtpHost: "" };
        const input = changeInput(account("work"), form);
        assert.deepEqual(input.allow, ["x@example.com"]);
        assert.equal(input.smtp_host, null);
    });

    it("sends a secret only when the field is filled", () => {
        const form = formFor(account("work"));
        assert.equal("password" in changeInput(account("work"), form), false);
        assert.equal(changeInput(account("work"), { ...form, password: "new" }).password, "new");
    });
});

describe("secret fields", () => {
    it("starts every secret field empty, even for an account that has a secret", () => {
        const form = formFor(account("work", { auth: "google", clientId: "id" }));
        assert.equal(form.password, "");
        assert.equal(form.clientSecret, "");
        assert.equal(emptyForm().password, "");
        assert.equal(emptyForm().clientSecret, "");
    });

    it("empties them after a call and keeps the rest", () => {
        const form = clearSecret(filled({ password: "p", clientSecret: "c" }));
        assert.equal(form.password, "");
        assert.equal(form.clientSecret, "");
        assert.equal(form.name, "work");
    });
});

describe("fieldsFor", () => {
    it("names the fields each auth kind needs", () => {
        assert.deepEqual(fieldsFor("password"), ["password"]);
        assert.deepEqual(fieldsFor("password_command"), ["passwordCommand"]);
        assert.deepEqual(fieldsFor("google"), ["clientId", "clientSecret"]);
        assert.deepEqual(fieldsFor("microsoft"), ["clientId", "tenant"]);
        assert.deepEqual(fieldsFor("microsoft_app"), ["clientId", "tenant", "clientSecret"]);
    });
});
