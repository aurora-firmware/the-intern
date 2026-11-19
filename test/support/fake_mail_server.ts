import imapkit from "imapkit";

export type FakeMailOptions = {
    /** Leave IDLE out of the IMAP capabilities when false. */
    idle?: boolean;
};

export type FakeMailAccount = { address: string; login: string; password: string };

export type FakeMailMessage = { uid: number; flags: string[]; raw: Buffer };

export type FakeMailServer = {
    imapPort: number;
    addAccount(account: FakeMailAccount): void;
    deliver(address: string, raw: string | Buffer): void;
    mailbox(address: string, folder: string): FakeMailMessage[];
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
 * Serves IMAP on a loopback port the system picks, with mailboxes in memory. The one module that imports `imapkit`,
 * so a replacement changes this file alone.
 *
 * The IMAP server holds one mailbox set, so a server serves one address; `addAccount` refuses a second one. Start a
 * second server for a second address.
 */
export async function startFakeMailServer(options: FakeMailOptions = {}): Promise<FakeMailServer> {
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

    function requireOwner(address: string): void {
        if (owner === undefined || owner !== address.toLowerCase()) {
            throw new Error(`no account for ${address}; add it with addAccount first`);
        }
    }

    return {
        imapPort,
        addAccount(account) {
            const address = account.address.toLowerCase();
            if (owner !== undefined && owner !== address) {
                throw new Error(`this fake serves one address, ${owner}; start a second server for ${account.address}`);
            }
            owner = address;
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
        async stop() {
            await imap.stop();
        },
    };
}
