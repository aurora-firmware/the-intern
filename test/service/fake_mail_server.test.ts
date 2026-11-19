import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { scaled } from "../support/time_scale.ts";

const SETTLE_TIMEOUT_MS = scaled(10_000);
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
});
