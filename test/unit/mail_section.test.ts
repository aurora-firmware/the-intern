import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, ConfigValueError, loadConfig } from "../../src/config/config_file.ts";
import { mailAccountSection, mailSection } from "../../src/mail/mail_section.ts";

const owned = {
    name: "intern",
    kind: "owned",
    address: "intern@example.com",
    imap_host: "imap.example.com",
    smtp_host: "smtp.example.com",
    auth: "password_command",
    password_command: ["pass", "intern"],
};

const fullOwned = {
    ...owned,
    imap_port: 993,
    imap_security: "tls",
    smtp_port: 465,
    smtp_security: "tls",
    login: "intern@example.com",
    check_interval_seconds: 60,
    triage_role: "triage",
    allow: ["boss@example.com", "@example.com"],
};

const monitored = {
    name: "ops",
    kind: "monitored",
    address: "ops@example.com",
    imap_host: "imap.example.com",
    auth: "google",
    client_id: "client-1",
};

const failureOf = (section: { parse(table: unknown): unknown }, table: unknown): ConfigValueError => {
    try {
        section.parse(table);
    } catch (error) {
        assert.ok(error instanceof ConfigValueError, String(error));
        return error;
    }
    return assert.fail("parse accepted the table");
};

const loadText = async (text: string): Promise<{ file: string; error: unknown }> => {
    const directory = await mkdtemp(join(tmpdir(), "mail-section-"));
    const file = join(directory, "config.toml");
    try {
        await writeFile(file, text);
        await loadConfig(file, [mailSection, mailAccountSection]);
        return { file, error: undefined };
    } catch (error) {
        return { file, error };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

describe("mailAccountSection", () => {
    it("writes_a_parsed_account_back_with_the_same_keys_and_values", () => {
        const accounts = mailAccountSection.parse([fullOwned]);
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0]?.imapPort, 993);
        assert.deepEqual(mailAccountSection.serialize(accounts), [fullOwned]);
    });

    it("gives_the_defaults_of_the_spec_to_keys_the_file_leaves_out", () => {
        const [account] = mailAccountSection.parse([owned]);
        assert.equal(account?.imapPort, 993);
        assert.equal(account?.smtpPort, 465);
        assert.equal(account?.checkIntervalSeconds, 60);
        assert.equal(account?.triageRole, "triage");
        assert.equal(account?.login, "intern@example.com");
    });

    it("leaves_out_the_keys_that_were_never_set", () => {
        const accounts = mailAccountSection.parse([monitored]);
        const [table] = mailAccountSection.serialize(accounts) as Record<string, unknown>[];
        assert.ok(table);
        for (const key of ["smtp_host", "smtp_port", "password_command", "tenant", "triage_role", "allow"]) {
            assert.equal(key in table, false, key);
        }
        assert.equal(table.client_id, "client-1");
        assert.deepEqual(mailAccountSection.parse([table]), accounts);
    });

    it("refuses_an_unknown_key_naming_the_account_and_the_key_secrets_included", () => {
        for (const key of ["password", "client_secret", "token", "color"]) {
            const error = failureOf(mailAccountSection, [{ ...owned, [key]: "x" }]);
            assert.equal(error.key, `intern.${key}`, key);
        }
    });

    it("names_the_account_and_the_key_of_a_value_that_breaks_a_rule", () => {
        const error = failureOf(mailAccountSection, [{ ...owned, imap_port: 0 }]);
        assert.equal(error.key, "intern.imap_port");
        assert.doesNotMatch(error.reason, /^intern: /);
    });

    it("refuses_two_accounts_with_one_name_naming_the_name", () => {
        const error = failureOf(mailAccountSection, [owned, { ...monitored, name: "intern" }]);
        assert.equal(error.key, "intern.name");
    });

    it("refuses_a_value_that_is_not_a_list_of_tables", () => {
        assert.equal(failureOf(mailAccountSection, { name: "a" }).key, "mail_account");
        assert.equal(failureOf(mailAccountSection, ["text"]).key, "1");
    });

    it("gives_no_accounts_when_the_file_has_none", () => {
        assert.deepEqual(mailAccountSection.defaults(), []);
    });
});

describe("mailSection", () => {
    it("parses_the_notice_settings_and_writes_them_back", () => {
        const table = { notice_to: "ops@example.com", notice_from: "intern" };
        const notice = mailSection.parse(table);
        assert.deepEqual(notice, { to: "ops@example.com", from: "intern" });
        assert.deepEqual(mailSection.serialize(notice), table);
    });

    it("gives_no_notice_settings_when_the_file_has_none", () => {
        assert.equal(mailSection.defaults(), undefined);
        assert.equal(mailSection.parse({}), undefined);
        assert.deepEqual(mailSection.serialize(undefined), {});
    });

    it("refuses_one_notice_key_without_the_other_naming_the_missing_key", () => {
        assert.equal(failureOf(mailSection, { notice_to: "ops@example.com" }).key, "notice_from");
        assert.equal(failureOf(mailSection, { notice_from: "intern" }).key, "notice_to");
    });

    it("refuses_an_unknown_key_and_a_value_that_is_not_text", () => {
        assert.equal(failureOf(mailSection, { password: "x" }).key, "password");
        assert.equal(failureOf(mailSection, { notice_to: 3, notice_from: "intern" }).key, "notice_to");
        assert.equal(failureOf(mailSection, { notice_to: "", notice_from: "intern" }).key, "notice_to");
    });
});

describe("loading the mail sections", () => {
    it("tells_the_file_the_account_and_the_key_of_an_unknown_key", async () => {
        const { file, error } = await loadText(
            '[[mail_account]]\nname = "a"\nkind = "monitored"\naddress = "a@b.c"\nimap_host = "h"\nauth = "google"\n' +
                'client_id = "c"\npassword = "x"\n',
        );
        assert.ok(error instanceof ConfigError, String(error));
        assert.equal(error.file, file);
        assert.equal(error.key, "mail_account.a.password");
    });

    it("tells_the_name_of_two_accounts_that_share_it", async () => {
        const account = '[[mail_account]]\nname = "a"\nkind = "monitored"\naddress = "a@b.c"\nimap_host = "h"\n';
        const { error } = await loadText(`${account}auth = "google"\nclient_id = "c"\n\n${account}auth = "google"\nclient_id = "c"\n`);
        assert.ok(error instanceof ConfigError, String(error));
        assert.equal(error.key, "mail_account.a.name");
    });

    it("tells_the_missing_notice_key", async () => {
        const { error } = await loadText('[mail]\nnotice_to = "ops@example.com"\n');
        assert.ok(error instanceof ConfigError, String(error));
        assert.equal(error.key, "mail.notice_from");
    });

    it("gives_no_accounts_and_no_notice_settings_for_a_file_without_mail_keys", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mail-section-"));
        const file = join(directory, "config.toml");
        try {
            await writeFile(file, "");
            const loaded = await loadConfig(file, [mailSection, mailAccountSection]);
            assert.deepEqual(loaded.values.get("mail_account"), []);
            assert.equal(loaded.values.get("mail"), undefined);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
