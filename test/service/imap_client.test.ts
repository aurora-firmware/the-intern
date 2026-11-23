import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import tls from "node:tls";
import { type ImapConnection, ImapFailure, type ImapOptions, openImap } from "../../src/mail/imap_client.ts";
import {
    type FakeMailSecurity,
    type FakeMailServer,
    startFakeMailServer,
    TEST_CA_FILE,
} from "../support/fake_mail_server.ts";
import { scaled } from "../support/time_scale.ts";

const ADDRESS = "ada@example.test";
const ACCOUNT = { address: ADDRESS, login: "ada", password: "ada-password-s3cret" };
const TOKEN = "ya29.token-s3cret";
const MESSAGE = "From: Grace <grace@example.test>\r\nTo: Ada <ada@example.test>\r\nSubject: Hello\r\n\r\nHi Ada.\r\n";
const WAIT_MS = scaled(10_000);
const PASSWORD_CREDENTIAL = { user: ACCOUNT.login, password: ACCOUNT.password };
const TOKEN_CREDENTIAL = { user: ACCOUNT.login, accessToken: TOKEN };

describe("imap client", () => {
    const cleanups: (() => Promise<void> | void)[] = [];
    const systemRoots = tls.getCACertificates("default");

    beforeEach(() => tls.setDefaultCACertificates([...systemRoots, readFileSync(TEST_CA_FILE, "utf8")]));

    afterEach(async () => {
        tls.setDefaultCACertificates(systemRoots);
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function start(security: FakeMailSecurity = "none"): Promise<FakeMailServer> {
        const server = await startFakeMailServer({ security });
        server.addAccount(ACCOUNT);
        server.acceptToken(ACCOUNT.login, TOKEN);
        cleanups.push(() => server.stop());
        return server;
    }

    function optionsFor(server: FakeMailServer, security: FakeMailSecurity, extra: Partial<ImapOptions> = {}) {
        return {
            host: "127.0.0.1",
            port: server.imapPort,
            security,
            credential: PASSWORD_CREDENTIAL,
            idleSeconds: 60,
            ...extra,
        };
    }

    async function connect(
        server: FakeMailServer,
        security: FakeMailSecurity,
        extra: Partial<ImapOptions> = {},
    ): Promise<ImapConnection> {
        const connection = await openImap(optionsFor(server, security, extra));
        cleanups.push(() => connection.logout());
        return connection;
    }

    async function failureOf(attempt: Promise<unknown>): Promise<ImapFailure> {
        try {
            await attempt;
        } catch (error) {
            assert.ok(error instanceof ImapFailure, `not an ImapFailure: ${String(error)}`);
            return error;
        }
        throw new Error("expected the attempt to fail");
    }

    describe("connecting", () => {
        for (const security of ["tls", "starttls", "none"] as const) {
            it(`logs in with a password over ${security}`, async () => {
                const server = await start(security);
                server.deliver(ADDRESS, MESSAGE);

                const connection = await connect(server, security);

                const { uidNext } = await connection.inboxState();
                assert.equal(uidNext, 2);
            });
        }

        it("logs in with an XOAUTH2 access token", async () => {
            const server = await start("tls");

            const connection = await connect(server, "tls", { credential: TOKEN_CREDENTIAL });

            assert.equal((await connection.inboxState()).uidNext, 1);
        });
    });

    describe("failing", () => {
        it("fails with kind certificate when the certificate does not verify", async () => {
            const server = await start("tls");
            tls.setDefaultCACertificates(systemRoots);

            const failure = await failureOf(openImap(optionsFor(server, "tls")));

            assert.equal(failure.kind, "certificate");
            assert.match(failure.message, /certificate/i);
        });

        it("fails with kind auth_refused and the server's message when the password is wrong", async () => {
            const server = await start();

            const failure = await failureOf(
                openImap(optionsFor(server, "none", { credential: { user: ACCOUNT.login, password: "wrong" } })),
            );

            assert.equal(failure.kind, "auth_refused");
            assert.notEqual(failure.message, "");
        });

        it("fails with kind auth_refused when the access token is not accepted", async () => {
            const server = await start();

            const failure = await failureOf(
                openImap(optionsFor(server, "none", { credential: { user: ACCOUNT.login, accessToken: "stale" } })),
            );

            assert.equal(failure.kind, "auth_refused");
        });

        it("fails with kind unreachable when nothing listens on the port", async () => {
            const server = await start();
            const options = optionsFor(server, "none");
            await server.stop();

            const failure = await failureOf(openImap(options));

            assert.equal(failure.kind, "unreachable");
        });

        // The 30 second limit is the product's own and imapflow enforces it on the socket, so no clock can be
        // moved: the test waits it out.
        it("fails with kind unreachable when the server does not answer within 30 seconds", async () => {
            const server = await start();
            server.pause();
            cleanups.push(() => server.resume());

            const failure = await failureOf(openImap(optionsFor(server, "none")));

            assert.equal(failure.kind, "unreachable");
        });

        it("fails with kind protocol when starttls is required and the server does not offer it", async () => {
            const server = await start("none");

            const failure = await failureOf(openImap(optionsFor(server, "starttls")));

            assert.equal(failure.kind, "protocol");
        });

        for (const [label, credential] of [
            ["password", { user: ACCOUNT.login, password: "wrong-p4ssword" }],
            ["token", { user: ACCOUNT.login, accessToken: "wrong-t0ken" }],
        ] as const) {
            it(`holds no ${label} in the error message or in the log`, async () => {
                const server = await start();
                const written: string[] = [];
                const capture = (chunk: unknown): boolean => {
                    written.push(String(chunk));
                    return true;
                };
                const { write: stdoutWrite } = process.stdout;
                const { write: stderrWrite } = process.stderr;
                process.stdout.write = capture;
                process.stderr.write = capture;
                let failure: ImapFailure;
                try {
                    failure = await failureOf(openImap(optionsFor(server, "none", { credential })));
                } finally {
                    process.stdout.write = stdoutWrite;
                    process.stderr.write = stderrWrite;
                }

                const secret = "password" in credential ? credential.password : credential.accessToken;
                assert.ok(!failure.message.includes(secret), failure.message);
                assert.ok(!written.join("").includes(secret));
                const encoded = Buffer.from(secret).toString("base64");
                assert.ok(!failure.message.includes(encoded));
            });
        }
    });

    describe("reading the inbox", () => {
        it("returns UIDVALIDITY and UIDNEXT of the inbox", async () => {
            const server = await start();
            server.setUidValidity(ADDRESS, 4242);
            server.deliver(ADDRESS, MESSAGE);
            const connection = await connect(server, "none");

            const state = await connection.inboxState();

            assert.deepEqual(state, { uidValidity: 4242, uidNext: 2 });
        });

        it("fetches the raw bytes of a message and leaves its flags unchanged", async () => {
            const server = await start();
            server.deliver(ADDRESS, MESSAGE);
            const connection = await connect(server, "none");
            await connection.inboxState();

            const raw = await connection.fetchRaw(1);

            assert.equal(Buffer.from(raw ?? []).toString("utf8"), MESSAGE);
            assert.deepEqual(server.mailbox(ADDRESS, "INBOX")[0]?.flags, []);
        });

        it("returns undefined for a UID the inbox does not hold", async () => {
            const server = await start();
            const connection = await connect(server, "none");
            await connection.inboxState();

            assert.equal(await connection.fetchRaw(99), undefined);
        });
    });

    describe("new mail", () => {
        it("calls the listener when a message arrives after idle() on a server that offers IDLE", async () => {
            const server = await start();
            const connection = await connect(server, "none");
            await connection.inboxState();
            const arrived = new Promise<void>((resolve, reject) => {
                connection.onNewMail(resolve);
                connection.idle();
                setTimeout(() => reject(new Error("no new mail announced")), WAIT_MS);
            });

            server.deliver(ADDRESS, MESSAGE);

            await arrived;
        });
    });
});
