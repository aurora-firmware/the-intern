import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkSmtpLogin, type SmtpOptions, type SmtpOutcome, sendRaw } from "../../src/mail/smtp_client.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";

const ADDRESS = "ada@example.test";
const PASSWORD = "ada-password-s3cret";
const TOKEN = "ya29.ada-token-s3cret";
const ACCOUNT = { address: ADDRESS, login: "ada", password: PASSWORD };
const RAW = Buffer.from(
    `From: Ada <${ADDRESS}>\r\nTo: bo@example.test, cy@example.test\r\nSubject: Hello\r\nMessage-ID: <hello@example.test>\r\n\r\nBody text.\r\n`,
);
const ENVELOPE = { from: ADDRESS, to: ["bo@example.test", "cy@example.test"] };

describe("smtp client", () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function serve(options: Parameters<typeof startFakeMailServer>[0] = {}): Promise<FakeMailServer> {
        const server = await startFakeMailServer(options);
        server.addAccount(ACCOUNT);
        server.acceptToken(ACCOUNT.login, TOKEN);
        cleanups.push(() => server.stop());
        return server;
    }

    function optionsFor(server: FakeMailServer, overrides: Partial<SmtpOptions> = {}): SmtpOptions {
        return {
            host: "127.0.0.1",
            port: server.smtpPort,
            security: "none",
            credential: { user: ACCOUNT.login, password: PASSWORD },
            ...overrides,
        };
    }

    function send(server: FakeMailServer, overrides: Partial<SmtpOptions> = {}): Promise<SmtpOutcome> {
        return sendRaw({ ...optionsFor(server, overrides), envelope: ENVELOPE, raw: RAW });
    }

    describe("a message the server takes", () => {
        it("hands the server the raw bytes once with the given envelope and reports sent", async () => {
            const server = await serve();

            const outcome = await send(server);

            assert.deepEqual(outcome, { kind: "sent", accepted: ENVELOPE.to, refused: [] });
            const [mail, ...others] = server.received();
            assert.equal(others.length, 0);
            assert.deepEqual(mail?.envelope, ENVELOPE);
            assert.ok(mail?.raw.equals(RAW), "the server did not receive the raw bytes unchanged");
        });

        it("sends with an OAuth access token", async () => {
            const server = await serve();

            const outcome = await send(server, { credential: { user: ACCOUNT.login, accessToken: TOKEN } });

            assert.equal(outcome.kind, "sent");
            assert.equal(server.received().length, 1);
        });

        it("sends without the upgrade to a server that offers STARTTLS when the security is none", async () => {
            const server = await serve({ security: "starttls" });

            const outcome = await send(server, { security: "none" });

            assert.equal(outcome.kind, "sent");
        });
    });

    describe("a failure before the server takes the message", () => {
        it("reports not_taken with the answer to a wrong password, without the password", async () => {
            const server = await serve();

            const outcome = await send(server, { credential: { user: ACCOUNT.login, password: "wrong-s3cret" } });

            assert.equal(outcome.kind, "not_taken");
            assert.match(outcome.kind === "not_taken" ? outcome.message : "", /Invalid credentials/);
            assert.equal(server.received().length, 0);
            assert.doesNotMatch(JSON.stringify(outcome), /wrong-s3cret/);
        });

        it("reports not_taken for a wrong token, without the token", async () => {
            const server = await serve();

            const outcome = await send(server, { credential: { user: ACCOUNT.login, accessToken: "bad-token-s3cret" } });

            assert.equal(outcome.kind, "not_taken");
            assert.doesNotMatch(JSON.stringify(outcome), /bad-token-s3cret/);
        });

        it("reports not_taken for a refused connection", async () => {
            const server = await serve();
            const port = server.smtpPort;
            await server.stop();

            const outcome = await sendRaw({
                ...optionsFor(server, { port }),
                envelope: ENVELOPE,
                raw: RAW,
            });

            assert.equal(outcome.kind, "not_taken");
        });

        it("reports not_taken when the security asks for an upgrade the server does not offer", async () => {
            const server = await serve({ security: "none" });

            const outcome = await send(server, { security: "starttls" });

            assert.equal(outcome.kind, "not_taken");
            assert.equal(server.received().length, 0);
        });
    });

    describe("a refusal", () => {
        it("reports refused with the answer when the server refuses every recipient", async () => {
            const server = await serve();
            server.refuseRecipient("bo@example.test", "550 no such user bo");
            server.refuseRecipient("cy@example.test", "550 no such user cy");

            const outcome = await send(server);

            assert.equal(outcome.kind, "refused");
            assert.match(outcome.kind === "refused" ? outcome.answer : "", /^550 .*no such user/);
            assert.equal(server.received().length, 0);
        });

        it("reports sent with the refused recipients and their answers when the server refuses only some", async () => {
            const server = await serve();
            server.refuseRecipient("cy@example.test", "550 no such user cy");

            const outcome = await send(server);

            assert.equal(outcome.kind, "sent");
            if (outcome.kind !== "sent") return;
            assert.deepEqual(outcome.accepted, ["bo@example.test"]);
            assert.equal(outcome.refused.length, 1);
            assert.equal(outcome.refused[0]?.address, "cy@example.test");
            assert.match(outcome.refused[0]?.answer ?? "", /^550 .*no such user cy/);
            assert.deepEqual(server.received()[0]?.envelope.to, ["bo@example.test"]);
        });
    });

    describe("a connection lost after the data", () => {
        it("reports unknown", async () => {
            const server = await serve();
            server.dropAfterData(true);

            const outcome = await send(server);

            assert.equal(outcome.kind, "unknown");
            assert.equal(server.received().length, 1);
        });
    });

    describe("the login check", () => {
        it("logs in and sends nothing", async () => {
            const server = await serve();

            const outcome = await checkSmtpLogin(optionsFor(server));

            assert.deepEqual(outcome, { ok: true });
            assert.equal(server.received().length, 0);
        });

        it("reports the answer to a wrong password, without the password", async () => {
            const server = await serve();

            const outcome = await checkSmtpLogin(
                optionsFor(server, { credential: { user: ACCOUNT.login, password: "wrong-s3cret" } }),
            );

            assert.equal(outcome.ok, false);
            assert.match(outcome.ok ? "" : outcome.message, /Invalid credentials/);
            assert.doesNotMatch(JSON.stringify(outcome), /wrong-s3cret/);
        });
    });
});
