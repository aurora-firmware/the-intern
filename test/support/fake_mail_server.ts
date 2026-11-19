import type net from "node:net";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";

export type FakeMailOptions = {
    /** Leave IDLE out of the IMAP capabilities when false. */
    idle?: boolean;
};

export type FakeMailAccount = { address: string; login: string; password: string };

export type FakeMailMessage = { uid: number; flags: string[]; raw: Buffer };

export type ReceivedMail = { envelope: { from: string | false; to: string[] }; raw: Buffer };

export type FakeMailServer = {
    imapPort: number;
    smtpPort: number;
    addAccount(account: FakeMailAccount): void;
    deliver(address: string, raw: string | Buffer): void;
    mailbox(address: string, folder: string): FakeMailMessage[];
    received(): ReceivedMail[];
    pause(): void;
    resume(): void;
    refuseRecipient(address: string, answer: string): void;
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
    const accounts = new Map<string, FakeMailAccount>();
    const mails: ReceivedMail[] = [];
    const refused = new Map<string, string>();
    const held = new Set<net.Socket>();
    let isPaused = false;
    let owner: string | undefined;

    const plugins = ["UIDPLUS", "SPECIAL-USE", "UNSELECT", "NAMESPACE", "ENABLE", "MOVE"];
    if (options.idle !== false) plugins.push("IDLE");
    const imap = imapkit({
        plugins,
        users: {},
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
        disabledCommands: ["STARTTLS"],
        allowInsecureAuth: true,
        authMethods: ["PLAIN", "LOGIN"],
        onAuth: (auth, _session, done) => {
            const account = auth.username === undefined ? undefined : accounts.get(auth.username);
            if (account !== undefined && auth.password === account.password) done(null, { user: account.address });
            else done(new Error("Invalid credentials"));
        },
        onRcptTo: (address, _session, done) => {
            const answer = refused.get(address.address.toLowerCase());
            if (answer === undefined) return done();
            done(Object.assign(new Error(answer.slice(4)), { responseCode: Number(answer.slice(0, 3)) }));
        },
        onData: (stream, session, done) => {
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
                mails.push({
                    envelope: {
                        from: session.envelope.mailFrom === false ? false : session.envelope.mailFrom.address,
                        to: session.envelope.rcptTo.map((recipient) => recipient.address),
                    },
                    raw: Buffer.concat(chunks),
                });
                done(null, "OK: queued");
            });
        },
    });
    await new Promise<void>((resolve) => smtp.listen(0, LOOPBACK, resolve));
    const smtpPort = (smtp.server.address() as net.AddressInfo).port;

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
        refuseRecipient(address, answer) {
            if (!/^5\d\d /.test(answer)) {
                throw new Error(`a refusal is a permanent 5xx answer such as "550 no such user", not "${answer}"`);
            }
            refused.set(address.toLowerCase(), answer);
        },
        async stop() {
            for (const connection of smtp.connections) connection._socket.destroy();
            await Promise.all([imap.stop(), new Promise<void>((resolve) => smtp.close(resolve))]);
        },
    };
}
