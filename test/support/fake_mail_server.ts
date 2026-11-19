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
        disabledCommands: ["STARTTLS"],
        allowInsecureAuth: true,
        authMethods: ["PLAIN", "LOGIN"],
        onAuth: (auth, _session, done) => {
            const account = auth.username === undefined ? undefined : accounts.get(auth.username);
            if (account !== undefined && auth.password === account.password) done(null, { user: account.address });
            else done(new Error("Invalid credentials"));
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
        async stop() {
            for (const connection of smtp.connections) connection._socket.destroy();
            await Promise.all([imap.stop(), new Promise<void>((resolve) => smtp.close(resolve))]);
        },
    };
}
