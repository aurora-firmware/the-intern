import { readFile } from "node:fs/promises";
import type net from "node:net";
import { fileURLToPath } from "node:url";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";

/** The test certificate authority, for a daemon child that trusts it through `NODE_EXTRA_CA_CERTS`. */
export const TEST_CA_FILE = fileURLToPath(new URL("../fixtures/tls/ca.pem", import.meta.url));

const TLS_KEY_FILE = new URL("../fixtures/tls/localhost.key", import.meta.url);
const TLS_CERT_FILE = new URL("../fixtures/tls/localhost.pem", import.meta.url);

export type FakeMailSecurity = "none" | "starttls" | "tls";

export type FakeMailOptions = {
    /** How clients reach both servers. `none` is plain text, `starttls` offers the upgrade, `tls` is implicit. */
    security?: FakeMailSecurity;
    /** Leave IDLE out of the IMAP capabilities when false. */
    idle?: boolean;
    /** Leave MOVE out of the IMAP capabilities when false. */
    move?: boolean;
};

export type FakeMailAccount = { address: string; login: string; password: string };

export type FakeMailMessage = { uid: number; flags: string[]; raw: Buffer };

export type ReceivedMail = { envelope: { from: string | false; to: string[] }; raw: Buffer };

export type FakeMailServer = {
    imapPort: number;
    smtpPort: number;
    addAccount(account: FakeMailAccount): void;
    acceptToken(login: string, token: string): void;
    deliver(address: string, raw: string | Buffer): void;
    mailbox(address: string, folder: string): FakeMailMessage[];
    setUidValidity(address: string, value: number): void;
    received(): ReceivedMail[];
    pause(): void;
    resume(): void;
    /** The number of IMAP and SMTP connections the server holds open. */
    openConnections(): number;
    setSlow(ms: number): void;
    refuseRecipient(address: string, answer: string): void;
    dropAfterData(on: boolean): void;
    stop(): Promise<void>;
};

const LOOPBACK = "127.0.0.1";

type SpecialUse = { name: string; attribute: string };

const SPECIAL_USE_FOLDERS: SpecialUse[] = [
    { name: "Drafts", attribute: "\\Drafts" },
    { name: "Sent", attribute: "\\Sent" },
    { name: "Trash", attribute: "\\Trash" },
];

/**
 * Serves IMAP and SMTP on loopback ports the system picks, with mailboxes in memory. The one module that imports `imapkit` and `smtp-server`,
 * so a replacement changes this file alone.
 *
 * The IMAP server holds one mailbox set, so a server serves one address; `addAccount` refuses a second one. Start a
 * second server for a second address.
 */
export async function startFakeMailServer(options: FakeMailOptions = {}): Promise<FakeMailServer> {
    const security = options.security ?? "none";
    const key = await readFile(TLS_KEY_FILE);
    const cert = await readFile(TLS_CERT_FILE);
    const accounts = new Map<string, FakeMailAccount>();
    const mails: ReceivedMail[] = [];
    const tokens = new Map<string, string>();
    const refused = new Map<string, string>();
    let slowMs = 0;
    let slowRules: { remove(): void }[] = [];
    let shouldDropAfterData = false;
    const held = new Set<net.Socket>();
    let isPaused = false;
    let owner: string | undefined;

    const plugins = ["UIDPLUS", "SPECIAL-USE", "UNSELECT", "NAMESPACE", "ENABLE", "SASL-IR", "XOAUTH2"];
    if (options.idle !== false) plugins.push("IDLE");
    if (options.move !== false) plugins.push("MOVE");
    if (security === "starttls") plugins.push("STARTTLS");
    const imap = imapkit({
        plugins,
        users: {},
        secureConnection: security === "tls",
        credentials: { key, cert },
        storage: {
            INBOX: { messages: [] },
            "": {
                separator: "/",
                folders: Object.fromEntries(
                    SPECIAL_USE_FOLDERS.map(({ name, attribute }) => [name, { "special-use": attribute }]),
                ),
            },
        },
    });
    const imapPort = await imap.start(0, LOOPBACK);

    const smtp = new SMTPServer({
        logger: false,
        disableReverseLookup: true,
        secure: security === "tls",
        key,
        cert,
        disabledCommands: security === "starttls" ? [] : ["STARTTLS"],
        allowInsecureAuth: true,
        authMethods: ["PLAIN", "LOGIN", "XOAUTH2"],
        onConnect: (_session, done) => later(() => done()),
        onAuth: (auth, _session, done) =>
            later(() => {
                const account = auth.username === undefined ? undefined : accounts.get(auth.username);
                const isAccepted =
                    account !== undefined &&
                    (auth.method === "XOAUTH2"
                        ? tokens.get(account.login) === auth.accessToken
                        : auth.password === account.password);
                if (isAccepted) done(null, { user: account.address });
                else done(new Error("Invalid credentials"));
            }),
        onMailFrom: (_address, _session, done) => later(() => done()),
        onRcptTo: (address, _session, done) =>
            later(() => {
                const answer = refused.get(address.address.toLowerCase());
                if (answer === undefined) return done();
                done(Object.assign(new Error(answer.slice(4)), { responseCode: Number(answer.slice(0, 3)) }));
            }),
        onData: (stream, session, done) => {
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () =>
                later(() => {
                    mails.push({
                        envelope: {
                            from: session.envelope.mailFrom === false ? false : session.envelope.mailFrom.address,
                            to: session.envelope.rcptTo.map((recipient) => recipient.address),
                        },
                        raw: Buffer.concat(chunks),
                    });
                    if (shouldDropAfterData) return dropConnection(session.id);
                    done(null, "OK: queued");
                }),
            );
        },
    });
    // A client that distrusts the certificate drops the handshake, which smtp-server reports as an error event.
    // That is the outcome such a test wants, so it never fails the test run.
    smtp.on("error", () => undefined);
    await new Promise<void>((resolve) => smtp.listen(0, LOOPBACK, resolve));
    const smtpPort = (smtp.server.address() as net.AddressInfo).port;

    function later(run: () => void): void {
        if (slowMs === 0) run();
        else setTimeout(run, slowMs);
    }

    function dropConnection(sessionId: string): void {
        for (const connection of smtp.connections) {
            if (connection.session.id === sessionId) connection._socket.destroy();
        }
    }

    function sockets(): net.Socket[] {
        const open = [...imap.connections].flatMap((connection) => (connection.socket ? [connection.socket] : []));
        return [...open, ...[...smtp.connections].map((connection) => connection._socket)];
    }

    function holdIfPaused(socket: net.Socket): void {
        if (!isPaused) return;
        socket.pause();
        held.add(socket);
    }
    for (const server of [imap.server, smtp.server]) {
        server.on("connection", holdIfPaused);
        server.on("secureConnection", holdIfPaused);
    }

    function requireOwner(address: string): void {
        if (owner === undefined || owner !== address.toLowerCase()) {
            throw new Error(`no account for ${address}; add it with addAccount first`);
        }
    }

    return {
        imapPort,
        smtpPort,
        addAccount(account) {
            const address = account.address.toLowerCase();
            if (owner !== undefined && owner !== address) {
                throw new Error(`this fake serves one address, ${owner}; start a second server for ${account.address}`);
            }
            owner = address;
            accounts.set(account.login, account);
            imap.control.addUser(account.login, { password: account.password });
        },
        acceptToken(login, token) {
            tokens.set(login, token);
            imap.control.updateUser(login, { xoauth2: { accessToken: token } });
        },
        deliver(address, raw) {
            requireOwner(address);
            imap.control.addMessage("INBOX", { raw });
        },
        mailbox(address, folder) {
            requireOwner(address);
            return imap.control
                .listMessages(folder, { raw: true })
                .map((message) => ({ uid: message.uid, flags: message.flags, raw: message.raw as Buffer }));
        },
        setUidValidity(address, value) {
            requireOwner(address);
            imap.control.resetUidValidity("INBOX", { uidvalidity: value });
        },
        received: () => [...mails],
        pause() {
            isPaused = true;
            for (const socket of sockets()) holdIfPaused(socket);
        },
        resume() {
            isPaused = false;
            for (const socket of [...held, ...sockets()]) socket.resume();
            held.clear();
        },
        openConnections: () => sockets().filter((socket) => !socket.destroyed).length,
        setSlow(ms) {
            slowMs = ms;
            for (const rule of slowRules) rule.remove();
            slowRules =
                ms > 0
                    ? imap.script.add([
                          { on: "greeting", delay: ms },
                          { on: "command", delay: ms },
                      ])
                    : [];
        },
        refuseRecipient(address, answer) {
            if (!/^5\d\d /.test(answer)) {
                throw new Error(`a refusal is a permanent 5xx answer such as "550 no such user", not "${answer}"`);
            }
            refused.set(address.toLowerCase(), answer);
        },
        dropAfterData(on) {
            shouldDropAfterData = on;
        },
        async stop() {
            for (const connection of smtp.connections) connection._socket.destroy();
            await Promise.all([imap.stop(), new Promise<void>((resolve) => smtp.close(resolve))]);
        },
    };
}
