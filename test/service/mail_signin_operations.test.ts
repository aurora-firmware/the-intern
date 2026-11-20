/**
 * The mail sign-in and connection test operations (T-427, S-009 REQ-003, REQ-004): what `mail.accounts.test` opens and
 * reports, which accounts `mail.accounts.signin` takes, and the account turning `ready` after the sign-in.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ServiceContext } from "../../src/daemon/daemon.ts";
import { mailOperations } from "../../src/service/mail_operations.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_BOUND_MS = scaled(20_000);
const POLL_INTERVAL_MS = 20;
const OWNED_ADDRESS = "intern@example.test";
const PASSWORD = "s3cret-pw";
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const CLOCK_STEP_MS = 2 * 60 * 60 * 1000;
const DEVICE_POLL_STEP_MS = 10_000;

type TestResult = { imap: { ok: boolean; message?: string }; smtp?: { ok: boolean; message?: string } };
type SignInStart = { kind: string; code?: string; address: string; port?: number };

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function start(options: Parameters<typeof startMailRig>[0]): Promise<MailRig> {
    const rig = await startMailRig(options);
    rigs.push(rig);
    return rig;
}

const configFile = (rig: MailRig): string => join(rig.env.configDir, "config.toml");
const secretFile = (rig: MailRig, name: string): string => join(rig.env.stateDir, "secrets", "mail", `${name}.json`);

async function storedAccessToken(rig: MailRig, name: string): Promise<string | undefined> {
    try {
        const secret = JSON.parse(await readFile(secretFile(rig, name), "utf8")) as { accessToken?: string };
        return secret.accessToken;
    } catch {
        return undefined;
    }
}

async function untilTrue(description: string, isWanted: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (!(await isWanted())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

function accountInput(rig: MailRig, name: string, extra: Record<string, unknown>): Record<string, unknown> {
    return {
        name,
        kind: "owned",
        address: OWNED_ADDRESS,
        imap_host: "127.0.0.1",
        imap_port: rig.server.imapPort,
        imap_security: "none",
        smtp_host: "127.0.0.1",
        smtp_port: rig.server.smtpPort,
        smtp_security: "none",
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

/**
 * The fake server accepts the access token the daemon stored, so the test tells it the token once it exists and moves the
 * mail clock past the retry pause until the account's login check passes.
 */
async function waitReadyWithStoredToken(rig: MailRig, name: string): Promise<void> {
    let clock = CLOCK_START;
    await untilTrue(`account ${name} to be ready`, async () => {
        const token = await storedAccessToken(rig, name);
        if (token === undefined) return false;
        rig.server.acceptToken(OWNED_ADDRESS, token);
        const { accounts } = (await rig.process().invoke("mail.accounts.list", {})) as {
            accounts: { name: string; status: string }[];
        };
        if (accounts.find((account) => account.name === name)?.status === "ready") return true;
        clock += CLOCK_STEP_MS;
        await rig.setClock(new Date(clock));
        return false;
    });
}

async function startWithOwnedAddress(): Promise<MailRig> {
    const rig = await start({ accounts: [] });
    rig.server.addAccount({ address: OWNED_ADDRESS, login: OWNED_ADDRESS, password: PASSWORD });
    return rig;
}

describe("mail.accounts.test", () => {
    it("reports IMAP and SMTP logged in, and sends and changes nothing (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({ accounts: [{ name: "intern", address: OWNED_ADDRESS, password: PASSWORD }] });
        await rig.waitForStatus("intern", "ready");
        const configBefore = await readFile(configFile(rig), "utf8");
        const inboxBefore = rig.server.mailbox(OWNED_ADDRESS, "INBOX").length;

        const result = (await rig.process().invoke("mail.accounts.test", { name: "intern" })) as TestResult;

        assert.deepEqual(result, { imap: { ok: true }, smtp: { ok: true } });
        assert.equal(rig.server.received().length, 0);
        assert.equal(rig.server.mailbox(OWNED_ADDRESS, "INBOX").length, inboxBefore);
        assert.equal(await readFile(configFile(rig), "utf8"), configBefore);
    });

    it("reports each server's message when a login fails (AC-1)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startWithOwnedAddress();
        await rig
            .process()
            .invoke(
                "mail.accounts.create",
                accountInput(rig, "wrong", { auth: "password", password: "not-the-password" }),
            );

        const result = (await rig.process().invoke("mail.accounts.test", { name: "wrong" })) as TestResult;

        assert.equal(result.imap.ok, false);
        assert.notEqual(result.imap.message, undefined);
        assert.equal(result.smtp?.ok, false);
        assert.match(result.smtp?.message ?? "", /credentials/i);
        assert.equal(JSON.stringify(result).includes("not-the-password"), false);
    });

    it("leaves SMTP out of the result for a monitored account", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startWithOwnedAddress();
        await rig.process().invoke("mail.accounts.create", {
            name: "watched",
            kind: "monitored",
            address: OWNED_ADDRESS,
            imap_host: "127.0.0.1",
            imap_port: rig.server.imapPort,
            imap_security: "none",
            auth: "password",
            password: PASSWORD,
        });

        const result = (await rig.process().invoke("mail.accounts.test", { name: "watched" })) as TestResult;

        assert.deepEqual(result, { imap: { ok: true } });
    });

    it("reports the failure of an account that has not signed in", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startWithOwnedAddress();
        await rig
            .process()
            .invoke(
                "mail.accounts.create",
                accountInput(rig, "work", { auth: "microsoft", client_id: "client-1", tenant: "contoso" }),
            );

        const result = (await rig.process().invoke("mail.accounts.test", { name: "work" })) as TestResult;

        assert.equal(result.imap.ok, false);
        assert.match(result.imap.message ?? "", /sign in/i);
        assert.equal(result.smtp?.ok, false);
    });

    it("refuses an unknown name not_found", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startWithOwnedAddress();

        const error = await refusal(rig.process().invoke("mail.accounts.test", { name: "nobody" }));

        assert.equal(error.code, "not_found");
    });

    it("checks a microsoft_app account with a token from the client credentials flow (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({
            accounts: [
                {
                    name: "app",
                    address: OWNED_ADDRESS,
                    password: PASSWORD,
                    microsoftApp: { clientId: "client-1", tenant: "contoso" },
                },
            ],
        });
        await untilTrue("the app token to be stored", async () => (await storedAccessToken(rig, "app")) !== undefined);
        const token = (await storedAccessToken(rig, "app")) as string;
        rig.server.acceptToken(OWNED_ADDRESS, token);

        const result = (await rig.process().invoke("mail.accounts.test", { name: "app" })) as TestResult;

        assert.deepEqual(result, { imap: { ok: true }, smtp: { ok: true } });
        assert.equal(rig.oauth.isValidAccessToken(token), true);
        assert.equal(
            rig.oauth.requests().some((request) => request.body.grant_type === "client_credentials"),
            true,
        );
    });
});

describe("mail.accounts.signin", () => {
    it("returns the code and address of a microsoft account, which turns ready once the code is entered (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startWithOwnedAddress();
        await rig
            .process()
            .invoke(
                "mail.accounts.create",
                accountInput(rig, "work", { auth: "microsoft", client_id: "client-1", tenant: "contoso" }),
            );

        const start = (await rig.process().invoke("mail.accounts.signin", { name: "work" })) as SignInStart;

        assert.equal(start.kind, "device_code");
        assert.equal(start.address, `${rig.oauth.endpoints.microsoftBase}/devicelogin`);
        rig.oauth.enterCode(start.code as string);
        await rig.setClock(new Date(CLOCK_START + DEVICE_POLL_STEP_MS));
        await waitReadyWithStoredToken(rig, "work");
    });

    it("asks the provider for the scopes of the account's provider (AC-2)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startWithOwnedAddress();
        await rig
            .process()
            .invoke(
                "mail.accounts.create",
                accountInput(rig, "work", { auth: "microsoft", client_id: "client-1", tenant: "contoso" }),
            );

        await rig.process().invoke("mail.accounts.signin", { name: "work" });

        const request = rig.oauth.requests().find((entry) => entry.path.endsWith("/devicecode"));
        assert.equal(
            request?.body.scope,
            "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
        );
    });

    it("turns a google account ready once the provider answers the loopback address (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startWithOwnedAddress();
        await rig.process().invoke(
            "mail.accounts.create",
            accountInput(rig, "gmail", {
                auth: "google",
                client_id: "client-1",
                clientSecret: "fake-oauth-client-secret",
            }),
        );

        const start = (await rig.process().invoke("mail.accounts.signin", { name: "gmail" })) as SignInStart;
        await rig.oauth.answerGoogle(start.address);

        assert.equal(start.kind, "browser");
        assert.equal(new URL(start.address).searchParams.get("scope"), "https://mail.google.com/");
        await waitReadyWithStoredToken(rig, "gmail");
    });

    it("refuses a password, password_command or microsoft_app account invalid_input (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await start({
            accounts: [{ name: "cmd", address: OWNED_ADDRESS, password: PASSWORD }],
        });
        await rig
            .process()
            .invoke("mail.accounts.create", accountInput(rig, "plain", { auth: "password", password: PASSWORD }));
        await rig.process().invoke(
            "mail.accounts.create",
            accountInput(rig, "app", {
                auth: "microsoft_app",
                client_id: "client-1",
                tenant: "contoso",
                clientSecret: "fake-oauth-client-secret",
            }),
        );

        for (const name of ["cmd", "plain", "app"]) {
            const error = await refusal(rig.process().invoke("mail.accounts.signin", { name }));

            assert.equal(error.code, "invalid_input", name);
        }
        assert.equal(rig.oauth.requests().filter((request) => request.path.endsWith("/devicecode")).length, 0);
    });

    it("refuses an unknown name not_found (AC-4)", { timeout: TEST_TIMEOUT_MS }, async () => {
        const rig = await startWithOwnedAddress();

        const error = await refusal(rig.process().invoke("mail.accounts.signin", { name: "nobody" }));

        assert.equal(error.code, "not_found");
    });
});

describe("mail.accounts.signin after the tokens are stored", () => {
    it("records a failed restart on the account's status instead of leaving it unhandled", async () => {
        const reports: { owner: string; name: string; outcome: { kind: string; message?: string } }[] = [];
        let signedIn: () => void = () => assert.fail("no sign-in started");
        const account = {
            name: "work",
            kind: "owned",
            auth: "microsoft",
            login: "bob@contoso.test",
            clientId: "client-1",
            tenant: "contoso",
        };
        const operations = mailOperations({
            agents: {} as never,
            accounts: {
                startSignIn: async (_auth: unknown, _scopes: unknown, onSignedIn: () => void) => {
                    signedIn = onSignedIn;
                    return { kind: "device_code", code: "U1", address: "https://example.test/devicelogin" };
                },
            } as never,
            secrets: {} as never,
            accountStatus: {
                get: () => undefined,
                report: (owner: string, name: string, outcome: { kind: string; message?: string }) =>
                    reports.push({ owner, name, outcome }),
            } as never,
            control: {
                restartAccount: async () => {
                    throw new Error("the secrets store is unreadable");
                },
                stopAccount: () => {},
            },
        });
        const signIn = operations.find((operation) => operation.name === "mail.accounts.signin");
        const context = { config: { current: () => [account] } } as unknown as ServiceContext;
        await signIn?.run(context, { name: "work" }, {} as never);

        signedIn();
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(reports, [
            { owner: "mail", name: "work", outcome: { kind: "failing", message: "the secrets store is unreadable" } },
        ]);
    });
});
