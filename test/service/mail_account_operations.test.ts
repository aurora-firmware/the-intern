/**
 * The mail account and notice settings operations (T-426, S-009 REQ-001, REQ-002, REQ-003, REQ-013): what each call
 * refuses, what it writes to the configuration file and the secrets store, and what it shows back.
 */
import assert from "node:assert/strict";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const OWNED_ADDRESS = "intern@example.test";
const PASSWORD = "s3cret-pw";

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function start(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [{ name: "intern", address: OWNED_ADDRESS, password: "pw" }] });
    rigs.push(rig);
    return rig;
}

const configFile = (rig: MailRig): string => join(rig.env.configDir, "config.toml");
const secretFile = (rig: MailRig, name: string): string => join(rig.env.stateDir, "secrets", "mail", `${name}.json`);
const readConfig = (rig: MailRig): Promise<string> => readFile(configFile(rig), "utf8");

function ownedInput(rig: MailRig, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name,
        kind: "owned",
        address: `${name}@example.test`,
        imap_host: "127.0.0.1",
        imap_port: rig.server.imapPort,
        imap_security: "none",
        smtp_host: "127.0.0.1",
        smtp_port: rig.server.smtpPort,
        smtp_security: "none",
        auth: "password",
        password: PASSWORD,
        ...extra,
    };
}

async function refusal(call: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
        await call;
    } catch (error) {
        return error as { code: string; message: string };
    }
    return assert.fail("the call was not refused");
}

async function accountNames(rig: MailRig): Promise<string[]> {
    const { accounts } = (await rig.process().invoke("mail.accounts.list", {})) as { accounts: { name: string }[] };
    return accounts.map((account) => account.name);
}

describe("the mail account operations", () => {
    it("refuses each broken rule of S-009 AC-001.1 invalid_input naming the key, leaving file and accounts as they were (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        const before = await readConfig(rig);
        const cases: [string, Record<string, unknown>][] = [
            ["name", { name: "bad name" }],
            ["kind", { kind: "shared" }],
            ["address", { address: "a@example.test, b@example.test" }],
            ["smtp_host", { kind: "monitored" }],
            ["client_id", { auth: "google", clientSecret: "x" }],
            ["password_command", { auth: "password_command" }],
            ["check_interval_seconds", { check_interval_seconds: 5 }],
            ["triage_role", { triage_role: "no-such-role" }],
            ["allow", { allow: ["example"] }],
        ];

        for (const [key, change] of cases) {
            const error = await refusal(
                rig.process().invoke("mail.accounts.create", ownedInput(rig, "extra", change)),
            );

            assert.equal(error.code, "invalid_input", key);
            assert.match(error.message, new RegExp(key), key);
        }
        assert.equal(await readConfig(rig), before);
        assert.deepEqual(await accountNames(rig), ["intern"]);
    });

    it("refuses a second account named intern conflict, naming the account (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        const before = await readConfig(rig);

        const error = await refusal(rig.process().invoke("mail.accounts.create", ownedInput(rig, "intern")));

        assert.equal(error.code, "conflict");
        assert.match(error.message, /intern/);
        assert.equal(await readConfig(rig), before);
    });

    it("writes the section and the secret, shows the password nowhere and removes both (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        const daemon = rig.process();

        const created = await daemon.invoke("mail.accounts.create", ownedInput(rig, "work"));
        const changed = await daemon.invoke("mail.accounts.change", { name: "work", allow: ["@example.com"] });
        const shown = await daemon.invoke("mail.accounts.get", { name: "work" });
        const listed = await daemon.invoke("mail.accounts.list", {});

        const file = await readConfig(rig);
        assert.match(file, /name = "work"/);
        assert.match(file, /@example\.com/);
        assert.doesNotMatch(file, new RegExp(PASSWORD));
        for (const result of [created, changed, shown, listed]) {
            assert.doesNotMatch(JSON.stringify(result), new RegExp(PASSWORD));
        }
        assert.match(await readFile(secretFile(rig, "work"), "utf8"), new RegExp(PASSWORD));
        const view = (changed as { account: { name: string; allow: string[]; status: string } }).account;
        assert.equal(view.name, "work");
        assert.deepEqual(view.allow, ["@example.com"]);
        assert.ok(["connecting", "ready", "failing"].includes(view.status), view.status);

        await daemon.invoke("mail.accounts.remove", { name: "work" });

        assert.doesNotMatch(await readConfig(rig), /name = "work"/);
        await assert.rejects(stat(secretFile(rig, "work")), { code: "ENOENT" });
        assert.deepEqual(await accountNames(rig), ["intern"]);
    });

    it("turns an account created without its password needs_sign_in (AC-3)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await start();
        const { password: _password, ...withoutPassword } = ownedInput(rig, "work");

        await rig.process().invoke("mail.accounts.create", withoutPassword);

        await rig.waitForStatus("work", "needs_sign_in");
    });

    it("refuses a change conflict when the file changed on disk, keeping the hand edit, and refuses removing the notice account (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        const daemon = rig.process();
        await daemon.invoke("mail.notices.set", { to: "ops@example.test", from: "intern" });
        const removal = await refusal(daemon.invoke("mail.accounts.remove", { name: "intern" }));
        assert.equal(removal.code, "conflict");
        assert.match(removal.message, /intern/);
        assert.ok((await accountNames(rig)).includes("intern"));
        await appendFile(configFile(rig), "\n# a hand edit\n");
        const edited = await readConfig(rig);

        const error = await refusal(daemon.invoke("mail.accounts.change", { name: "intern", check_interval_seconds: 30 }));

        assert.equal(error.code, "conflict");
        assert.ok(error.message.includes(configFile(rig)), error.message);
        assert.equal(await readConfig(rig), edited);
    });
});

describe("the mail notice settings operations", () => {
    it("refuses an owned account's address as `to`, and a monitored or SMTP-less account as `from`; neither clears (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start();
        const daemon = rig.process();
        const monitored = ownedInput(rig, "watch", { kind: "monitored" });
        delete monitored.smtp_host;
        delete monitored.smtp_port;
        delete monitored.smtp_security;
        await daemon.invoke("mail.accounts.create", monitored);
        const smtpLess = ownedInput(rig, "nosmtp");
        delete smtpLess.smtp_host;
        delete smtpLess.smtp_port;
        await daemon.invoke("mail.accounts.create", smtpLess);

        const refusals = await Promise.all([
            refusal(daemon.invoke("mail.notices.set", { to: OWNED_ADDRESS.toUpperCase(), from: "intern" })),
            refusal(daemon.invoke("mail.notices.set", { to: "ops@example.test", from: "watch" })),
            refusal(daemon.invoke("mail.notices.set", { to: "ops@example.test", from: "nosmtp" })),
        ]);
        for (const error of refusals) assert.equal(error.code, "invalid_input");
        assert.deepEqual(await daemon.invoke("mail.notices.get", {}), { notice: {} });

        await daemon.invoke("mail.notices.set", { to: "ops@example.test", from: "intern" });
        assert.deepEqual(await daemon.invoke("mail.notices.get", {}), {
            notice: { to: "ops@example.test", from: "intern" },
        });
        await daemon.invoke("mail.notices.set", {});

        assert.deepEqual(await daemon.invoke("mail.notices.get", {}), { notice: {} });
        assert.doesNotMatch(await readConfig(rig), /notice_to/);
    });
});
