/**
 * The mail tools' connections (S-009 REQ-011): one IMAP connection per account, apart from intake's, opened at the
 * first call and closed after a quiet spell. Calls on one account run one after another, so a call that opens a folder
 * keeps it until it is done.
 */

import type { AccountStatusKind } from "../accounts/account_status.ts";
import type { Credential } from "../accounts/providers.ts";
import { type ImapConnection, ImapFailure, type ImapOptions, openImap } from "./imap_client.ts";
import type { MailAccount } from "./mail_model.ts";

export const TOOL_CONNECTION_IDLE_MS = 5 * 60 * 1000;

/** A call the tools refuse before or while reading: the reason goes to the agent as an error result. */
export class MailToolRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MailToolRefusal";
    }
}

export type ToolConnectionDeps = {
    account(name: string): MailAccount | undefined;
    status(name: string): AccountStatusKind | undefined;
    credential(account: MailAccount): Promise<Credential>;
    /** Opens the connection; `openImap` by default. */
    open?(options: ImapOptions): Promise<ImapConnection>;
    /** How long a connection may sit unused before it is closed. */
    idleMs?: number;
};

export type ToolConnections = {
    /** Runs `run` on the account's connection, opening it first when none is open. */
    use<T>(accountName: string, run: (imap: ImapConnection, account: MailAccount) => Promise<T>): Promise<T>;
    /** Closes the account's connection; the next call opens another. */
    close(accountName: string): Promise<void>;
    closeAll(): Promise<void>;
};

type Held = {
    account: MailAccount;
    imap: Promise<ImapConnection>;
    /** Ends when the calls queued so far are done. */
    tail: Promise<unknown>;
    idleTimer?: NodeJS.Timeout;
};

/**
 * Leaves a folder open with EXAMINE, so the connection lasts its idle minutes. With a folder open the client idles,
 * and it answers its own quiet-socket timeout with a NOOP; with none open, the timeout closes the connection after
 * 30 quiet seconds. The search asks for messages received from tomorrow on, so the answer stays empty however large
 * the INBOX is.
 */
async function openInboxReadOnly(imap: ImapConnection): Promise<void> {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await imap.search("INBOX", { since: tomorrow }, 0);
}

export function createToolConnections(deps: ToolConnectionDeps): ToolConnections {
    const open = deps.open ?? openImap;
    const idleMs = deps.idleMs ?? TOOL_CONNECTION_IDLE_MS;
    const held = new Map<string, Held>();

    function requireReady(name: string): MailAccount {
        const account = deps.account(name);
        if (account === undefined) throw new MailToolRefusal(`There is no mail account named "${name}".`);
        const status = deps.status(name);
        if (status !== "ready") {
            throw new MailToolRefusal(`The mail account "${name}" is ${status ?? "not started"}, not ready.`);
        }
        return account;
    }

    async function drop(name: string): Promise<void> {
        const entry = held.get(name);
        if (entry === undefined) return;
        held.delete(name);
        clearTimeout(entry.idleTimer);
        const imap = await entry.imap.catch(() => undefined);
        await imap?.logout();
    }

    function hold(account: MailAccount): Held {
        const imap = deps.credential(account).then(async (credential) => {
            const connection = await open({
                host: account.imapHost,
                port: account.imapPort,
                security: account.imapSecurity,
                credential,
                idleSeconds: account.checkIntervalSeconds,
            });
            try {
                await openInboxReadOnly(connection);
            } catch (error) {
                await connection.logout();
                throw error;
            }
            return connection;
        });
        const entry: Held = { account, imap, tail: Promise.resolve() };
        held.set(account.name, entry);
        return entry;
    }

    function restartIdleTimer(entry: Held): void {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => void drop(entry.account.name), idleMs);
        entry.idleTimer.unref();
    }

    async function use<T>(
        accountName: string,
        run: (imap: ImapConnection, account: MailAccount) => Promise<T>,
    ): Promise<T> {
        const account = requireReady(accountName);
        const entry = held.get(accountName) ?? hold(account);
        clearTimeout(entry.idleTimer);
        const dropEntry = async (): Promise<void> => {
            if (held.get(accountName) === entry) await drop(accountName);
        };
        const call = entry.tail.then(async (): Promise<T> => {
            // A call ahead of this one on the chain may have dropped the connection; this one opens another.
            if (held.get(accountName) !== entry) return use(accountName, run);
            let imap: ImapConnection;
            try {
                imap = await entry.imap;
            } catch (error) {
                await dropEntry();
                throw error;
            }
            try {
                return await run(imap, entry.account);
            } catch (error) {
                // Only a lost connection is dropped: a refusal of the call, or the server's own `NO`, leaves it usable.
                if (error instanceof ImapFailure && error.kind !== "protocol") await dropEntry();
                throw error;
            }
        });
        entry.tail = call.catch(() => undefined);
        try {
            return await call;
        } finally {
            if (held.get(accountName) === entry) {
                await entry.tail;
                restartIdleTimer(entry);
            }
        }
    }

    return {
        use,
        close: drop,
        async closeAll() {
            await Promise.all([...held.keys()].map(drop));
        },
    };
}
