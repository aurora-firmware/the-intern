import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import tls from "node:tls";
import nodemailer, { type Transporter } from "nodemailer";
import { type FakeMailServer, startFakeMailServer, TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { scaled } from "../support/time_scale.ts";

const SETTLE_TIMEOUT_MS = scaled(10_000);
/** A server command answers within a few event loop turns, so the watcher runs well past them. */
const WATCHER_ROUNDS = 5;
const ADDRESS = "ada@example.test";
const ACCOUNT = { address: ADDRESS, login: "ada", password: "ada-password" };

const MESSAGE = "From: Grace <grace@example.test>\r\nTo: Ada <ada@example.test>\r\nSubject: Hello\r\n\r\nHi Ada.\r\n";

/** A bare IMAP connection: lines go out as written, and a read waits until the wanted text has come in. */
class RawClient {
    readonly socket: net.Socket;
    private received = "";
    private readonly waiters = new Set<() => void>();

    constructor(socket: net.Socket) {
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            this.received += chunk;
            this.wake();
        });
    }

    static async connect(port: number): Promise<RawClient> {
        const socket = net.connect({ host: "127.0.0.1", port });
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        return new RawClient(socket);
    }

    send(line: string): void {
        this.socket.write(`${line}\r\n`);
    }

    /** Resolves with everything received so far once it matches `wanted`; the match is then consumed. */
    async until(wanted: RegExp): Promise<string> {
        let isLate = false;
        const timer = setTimeout(() => {
            isLate = true;
            this.wake();
        }, SETTLE_TIMEOUT_MS);
        try {
            for (;;) {
                const match = wanted.exec(this.received);
                if (match !== null) {
                    const consumed = this.received.slice(0, match.index + match[0].length);
                    this.received = this.received.slice(consumed.length);
                    return consumed;
                }
                if (isLate) throw new Error(`no ${wanted} in: ${JSON.stringify(this.received)}`);
                await new Promise<void>((resolve) => this.waiters.add(resolve));
            }
        } finally {
            clearTimeout(timer);
        }
    }

    private wake(): void {
        for (const wake of [...this.waiters]) {
            this.waiters.delete(wake);
            wake();
        }
    }

    /** What has come in and not been consumed yet. */
    get unread(): string {
        return this.received;
    }

    close(): void {
        this.socket.destroy();
    }
}

describe("fake mail server", () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function start(options: Parameters<typeof startFakeMailServer>[0] = {}): Promise<FakeMailServer> {
        const server = await startFakeMailServer(options);
        server.addAccount(ACCOUNT);
        cleanups.push(() => server.stop());
        return server;
    }

    async function signedIn(server: FakeMailServer): Promise<RawClient> {
        const client = await RawClient.connect(server.imapPort);
        cleanups.push(() => client.close());
        await client.until(/^\* OK .*\r\n/);
        client.send(`a1 LOGIN ${ACCOUNT.login} ${ACCOUNT.password}`);
        await client.until(/^a1 OK .*\r\n/m);
        return client;
    }

    /**
     * A connection in IDLE that proves the server has run on: a delivery is pushed to it even while the server reads
     * nothing, so its announcement comes after anything the server would have answered by then.
     */
    async function watcher(server: FakeMailServer): Promise<() => Promise<void>> {
        const client = await signedIn(server);
        client.send("w1 SELECT INBOX");
        await client.until(/^w1 OK .*\r\n/m);
        client.send("w2 IDLE");
        await client.until(/^\+ .*\r\n/);
        let count = 0;
        return async () => {
            for (let round = 0; round < WATCHER_ROUNDS; round += 1) {
                count += 1;
                server.deliver(ADDRESS, MESSAGE);
                await client.until(new RegExp(`^\\* ${count} EXISTS\\r\\n`, "m"));
            }
        };
    }

    describe("delivery", () => {
        it("serves a delivered message in INBOX with the UID the INBOX announced as next", async () => {
            const server = await start();
            const client = await signedIn(server);
            client.send("a2 SELECT INBOX");
            const selected = await client.until(/^a2 OK .*\r\n/m);
            const uidNext = Number(/\[UIDNEXT (\d+)\]/.exec(selected)?.[1]);

            server.deliver(ADDRESS, MESSAGE);

            const [stored] = server.mailbox(ADDRESS, "INBOX");
            assert.equal(stored?.uid, uidNext);
            assert.equal(stored?.raw.toString("utf8"), MESSAGE);
            client.send(`a3 UID FETCH ${uidNext} (BODY.PEEK[])`);
            const fetched = await client.until(/^a3 OK .*\r\n/m);
            assert.ok(fetched.includes("Subject: Hello"), fetched);
        });

        it("announces a delivered message to a connection in IDLE", async () => {
            const server = await start();
            const client = await signedIn(server);
            client.send("a2 SELECT INBOX");
            await client.until(/^a2 OK .*\r\n/m);
            client.send("a3 IDLE");
            await client.until(/^\+ .*\r\n/);

            server.deliver(ADDRESS, MESSAGE);

            await client.until(/^\* 1 EXISTS\r\n/m);
        });

        it("leaves IDLE out of the capabilities when started with idle false", async () => {
            const server = await start({ idle: false });
            const client = await signedIn(server);
            client.send("a2 CAPABILITY");
            const capabilities = await client.until(/^a2 OK .*\r\n/m);
            assert.ok(!/\bIDLE\b/.test(capabilities), capabilities);
            assert.ok(/\bMOVE\b/.test(capabilities), capabilities);
        });
    });

    function transportTo(server: FakeMailServer): Transporter {
        const transport = nodemailer.createTransport({
            host: "127.0.0.1",
            port: server.smtpPort,
            ignoreTLS: true,
            auth: { user: ACCOUNT.login, pass: ACCOUNT.password },
        });
        cleanups.push(() => transport.close());
        return transport;
    }

    describe("submission", () => {
        it("records the envelope and the raw bytes of a message submitted over SMTP", async () => {
            const server = await start();
            const transport = transportTo(server);

            await transport.sendMail({
                envelope: { from: ADDRESS, to: ["grace@example.test", "linus@example.test"] },
                raw: MESSAGE,
            });

            const [mail, ...others] = server.received();
            assert.equal(others.length, 0);
            assert.deepEqual(mail?.envelope, { from: ADDRESS, to: ["grace@example.test", "linus@example.test"] });
            assert.equal(mail?.raw.toString("utf8"), MESSAGE);
        });
    });

    describe("pause", () => {
        it("answers no IMAP command while paused and answers it after resume", async () => {
            const server = await start();
            const serverRuns = await watcher(server);
            const client = await signedIn(server);
            server.pause();

            client.send("a2 NOOP");
            await serverRuns();

            assert.equal(client.unread, "");
            server.resume();
            await client.until(/^a2 OK .*\r\n/m);
        });

        it("answers no SMTP command while paused and answers it after resume", async () => {
            const server = await start();
            const serverRuns = await watcher(server);
            const client = await RawClient.connect(server.smtpPort);
            cleanups.push(() => client.close());
            await client.until(/^220 .*\r\n/m);
            server.pause();

            client.send("EHLO tester.example.test");
            await serverRuns();

            assert.equal(client.unread, "");
            server.resume();
            await client.until(/^250 .*\r\n/m);
        });

        it("answers no command on a connection made while paused", async () => {
            const server = await start();
            const serverRuns = await watcher(server);
            server.pause();
            const client = await RawClient.connect(server.imapPort);
            cleanups.push(() => client.close());
            await client.until(/^\* OK .*\r\n/);

            client.send("a1 CAPABILITY");
            await serverRuns();

            assert.equal(client.unread, "");
            server.resume();
            await client.until(/^a1 OK .*\r\n/m);
        });
    });

    describe("refused recipients", () => {
        it("answers a refused recipient with the given 5xx and records nothing for it", async () => {
            const server = await start();
            server.refuseRecipient("nobody@example.test", "550 5.1.1 no such user");
            const transport = transportTo(server);

            const result = await transport.sendMail({
                envelope: { from: ADDRESS, to: ["nobody@example.test", "grace@example.test"] },
                raw: MESSAGE,
            });

            assert.deepEqual(result.rejected, ["nobody@example.test"]);
            assert.equal(result.rejectedErrors?.[0]?.responseCode, 550);
            assert.match(result.rejectedErrors?.[0]?.response ?? "", /5\.1\.1 no such user/);
            assert.deepEqual(
                server.received().map((mail) => mail.envelope.to),
                [["grace@example.test"]],
            );
        });

        it("records no message when every recipient is refused", async () => {
            const server = await start();
            server.refuseRecipient("Nobody@Example.test", "550 no such user");
            const transport = transportTo(server);

            await assert.rejects(
                transport.sendMail({ envelope: { from: ADDRESS, to: ["nobody@example.test"] }, raw: MESSAGE }),
                (error: { responseCode?: number }) => error.responseCode === 550,
            );

            assert.deepEqual(server.received(), []);
        });

        it("refuses a refusal that is not a permanent answer", async () => {
            const server = await start();
            assert.throws(() => server.refuseRecipient("nobody@example.test", "450 try later"), /permanent 5xx/);
        });
    });

    describe("certificate", () => {
        async function handshake(
            socket: net.Socket | undefined,
            port: number,
            trusted: boolean,
        ): Promise<tls.TLSSocket> {
            const secure = tls.connect({
                ...(socket === undefined ? { host: "localhost", port } : { socket }),
                servername: "localhost",
                ...(trusted ? { ca: await readFile(TEST_CA_FILE) } : {}),
            });
            cleanups.push(() => {
                secure.destroy();
            });
            await new Promise<void>((resolve, reject) => {
                secure.once("secureConnect", resolve);
                secure.once("error", reject);
            });
            return secure;
        }

        async function startTlsOnImap(server: FakeMailServer): Promise<net.Socket> {
            const plain = await RawClient.connect(server.imapPort);
            await plain.until(/^\* OK .*\r\n/);
            plain.send("a1 STARTTLS");
            await plain.until(/^a1 OK .*\r\n/m);
            plain.socket.removeAllListeners("data");
            return plain.socket;
        }

        it("presents the localhost certificate to an IMAP client that trusts the test authority over TLS", async () => {
            const server = await start({ security: "tls" });
            const secure = await handshake(undefined, server.imapPort, true);
            assert.equal(secure.authorized, true);
            assert.equal(secure.getPeerCertificate().subject.CN, "localhost");
        });

        it("fails to verify the certificate for an IMAP client that does not trust the test authority", async () => {
            const server = await start({ security: "tls" });
            await assert.rejects(
                handshake(undefined, server.imapPort, false),
                (error: NodeJS.ErrnoException) => error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            );
        });

        it("presents the localhost certificate after STARTTLS on IMAP", async () => {
            const server = await start({ security: "starttls" });
            const secure = await handshake(await startTlsOnImap(server), 0, true);
            assert.equal(secure.authorized, true);
            assert.equal(secure.getPeerCertificate().subject.CN, "localhost");
        });

        it("fails to verify the certificate after STARTTLS on IMAP for a client that does not trust the authority", async () => {
            const server = await start({ security: "starttls" });
            await assert.rejects(
                handshake(await startTlsOnImap(server), 0, false),
                (error: NodeJS.ErrnoException) => error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            );
        });

        it("serves SMTP over TLS to a client that trusts the test authority and not to one that does not", async () => {
            const server = await start({ security: "tls" });
            const trusting = nodemailer.createTransport({
                host: "localhost",
                port: server.smtpPort,
                secure: true,
                tls: { ca: await readFile(TEST_CA_FILE) },
                auth: { user: ACCOUNT.login, pass: ACCOUNT.password },
            });
            const distrusting = nodemailer.createTransport({ host: "localhost", port: server.smtpPort, secure: true });
            cleanups.push(
                () => trusting.close(),
                () => distrusting.close(),
            );

            assert.equal(await trusting.verify(), true);
            await assert.rejects(distrusting.verify(), (error: { code?: string }) => error.code === "ESOCKET");
        });

        it("serves SMTP after STARTTLS to a client that trusts the test authority and not to one that does not", async () => {
            const server = await start({ security: "starttls" });
            const options = { host: "localhost", port: server.smtpPort, requireTLS: true };
            const trusting = nodemailer.createTransport({
                ...options,
                tls: { ca: await readFile(TEST_CA_FILE) },
                auth: { user: ACCOUNT.login, pass: ACCOUNT.password },
            });
            const distrusting = nodemailer.createTransport(options);
            cleanups.push(
                () => trusting.close(),
                () => distrusting.close(),
            );

            assert.equal(await trusting.verify(), true);
            await assert.rejects(distrusting.verify(), (error: { code?: string }) => error.code === "ESOCKET");
        });
    });
});
