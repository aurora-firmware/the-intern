import { ImapFlow, type ImapFlowError, type SearchObject } from "imapflow";
import type { Credential } from "../accounts/providers.ts";
import type { MailSecurity } from "./mail_model.ts";

export type ImapFailureKind = "certificate" | "auth_refused" | "unreachable" | "protocol";

/** A failed connection or command. The message is the server's answer or the library's, never the command sent. */
export class ImapFailure extends Error {
    readonly kind: ImapFailureKind;

    constructor(kind: ImapFailureKind, message: string) {
        super(message);
        this.name = "ImapFailure";
        this.kind = kind;
    }
}

export type ImapOptions = {
    host: string;
    port: number;
    security: MailSecurity;
    credential: Credential;
    /** How long a quiet connection waits before it restarts IDLE, or polls on a server without IDLE. */
    idleSeconds: number;
};

/** Names one message for good: UIDs mean nothing once the folder's UIDVALIDITY changes. */
export type MessageRef = { folder: string; uidValidity: number; uid: number };

export type FolderInfo = {
    path: string;
    /** The SPECIAL-USE attribute the server reports, such as `\\Trash`. */
    specialUse?: string;
};

export type SpecialFolderKind = "drafts" | "sent" | "trash";

export type SearchQuery = {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    /** Received on or after this day. */
    since?: Date;
    /** Received before this day. */
    before?: Date;
    seen?: boolean;
    flagged?: boolean;
    answered?: boolean;
};

export type FlagChanges = { seen?: boolean; flagged?: boolean; answered?: boolean };

export type ImapConnection = {
    listFolders(): Promise<FolderInfo[]>;
    /** The folder for Drafts, Sent or Trash, found by SPECIAL-USE and then by its usual name; undefined when none. */
    specialFolder(kind: SpecialFolderKind): Promise<string | undefined>;
    /** Opens the folder read-only and returns at most `limit` matches, the highest UIDs (the newest) first. */
    search(folder: string, query: SearchQuery, limit: number): Promise<MessageRef[]>;
    /** Reads the raw bytes with BODY.PEEK[]; refused when the folder's UIDVALIDITY differs from the ref's. */
    fetchMessage(ref: MessageRef): Promise<Uint8Array>;
    /** Moves to an existing folder with MOVE; refused, with nothing moved, on a server without it. */
    move(refs: MessageRef[], target: string): Promise<void>;
    /** Sets or clears only the flags named; others stay as they are. */
    setFlags(refs: MessageRef[], changes: FlagChanges): Promise<void>;
    append(folder: string, raw: Uint8Array, flags: string[]): Promise<void>;
    hasMessageId(folder: string, messageId: string): Promise<boolean>;
    /** Selects INBOX and returns its UIDVALIDITY and UIDNEXT. */
    inboxState(): Promise<{ uidValidity: number; uidNext: number }>;
    /** Reads a message's bytes with BODY.PEEK[], so no flag changes. */
    fetchRaw(uid: number): Promise<Uint8Array>;
    /** Calls the listener each time the server announces a message in INBOX. */
    onNewMail(listener: () => void): void;
    logout(): Promise<void>;
};

const USUAL_NAMES: Record<SpecialFolderKind, string[]> = {
    drafts: ["drafts", "draft"],
    sent: ["sent", "sent items", "sent mail", "sent messages"],
    trash: ["trash", "deleted items", "deleted messages", "bin"],
};
const SPECIAL_USE_ATTRIBUTES: Record<SpecialFolderKind, string> = {
    drafts: "\\Drafts",
    sent: "\\Sent",
    trash: "\\Trash",
};
const FLAG_NAMES = { seen: "\\Seen", flagged: "\\Flagged", answered: "\\Answered" } as const;

/** The path of the folder with the kind's SPECIAL-USE attribute, else one with a usual name, else undefined. */
export function pickSpecialFolder(folders: FolderInfo[], kind: SpecialFolderKind): string | undefined {
    const byAttribute = folders.find((folder) => folder.specialUse === SPECIAL_USE_ATTRIBUTES[kind]);
    if (byAttribute !== undefined) return byAttribute.path;
    const names = USUAL_NAMES[kind];
    return folders.find((folder) => names.includes(folder.path.toLowerCase()))?.path;
}

/** imapflow reads a key set to undefined as a criterion, so leave the unset ones out. */
function searchCriteria(query: SearchQuery): SearchObject {
    const criteria = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
    return Object.keys(criteria).length === 0 ? { all: true } : criteria;
}

const TIMEOUT_MS = 30_000;
const INBOX = "INBOX";
const CERTIFICATE_CODES =
    /^(CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|ERR_TLS_CERT|HOSTNAME_MISMATCH)/;
const UNREACHABLE_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "CONNECT_TIMEOUT",
    "GREETING_TIMEOUT",
    "UPGRADE_TIMEOUT",
    "ETIMEOUT",
    "NoConnection",
    "EConnectionClosed",
    "ClosedAfterConnectText",
    "ClosedAfterConnectTLS",
]);

/** The error imapflow wraps in `_err` keeps Node's own code, such as the certificate check's. */
function codeOf(error: ImapFlowError): string | undefined {
    const inner = error._err as ImapFlowError | undefined;
    return inner?.code ?? error.code;
}

function failureKindOf(error: ImapFlowError): ImapFailureKind {
    const code = codeOf(error) ?? "";
    if (error.authenticationFailed === true) return "auth_refused";
    if (CERTIFICATE_CODES.test(code)) return "certificate";
    if (UNREACHABLE_CODES.has(code)) return "unreachable";
    return "protocol";
}

function toFailure(error: unknown): ImapFailure {
    if (error instanceof ImapFailure) return error;
    const cause = error as ImapFlowError;
    const message = cause.responseText ?? cause.message;
    return new ImapFailure(failureKindOf(cause), message === undefined || message === "" ? "IMAP failure" : message);
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw toFailure(error);
    }
}

function authOf(credential: Credential): { user: string; pass: string } | { user: string; accessToken: string } {
    return "password" in credential
        ? { user: credential.user, pass: credential.password }
        : { user: credential.user, accessToken: credential.accessToken };
}

/**
 * Connects and logs in. The only module that imports `imapflow`. It never calls `mailboxClose` and never sends
 * EXPUNGE or CLOSE: IMAP CLOSE expunges messages a person marked deleted.
 */
export async function openImap(options: ImapOptions): Promise<ImapConnection> {
    const client = new ImapFlow({
        host: options.host,
        port: options.port,
        secure: options.security === "tls",
        doSTARTTLS: options.security === "starttls",
        auth: authOf(options.credential),
        logger: false,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
        maxIdleTime: options.idleSeconds * 1000,
    });
    // imapflow emits `error` for a lost connection and throws when nobody listens. The command that was running
    // rejects with the same error, and that rejection is what the caller sees.
    client.on("error", () => undefined);
    await guarded(() => client.connect());

    async function openFolder(folder: string, readOnly: boolean) {
        return client.mailboxOpen(folder, { readOnly });
    }

    /** Opens the refs' one folder and refuses when its UIDVALIDITY is no longer the refs'. */
    async function openForRefs(refs: MessageRef[], readOnly: boolean): Promise<string> {
        const [first] = refs;
        if (first === undefined) throw new ImapFailure("protocol", "no messages named");
        if (refs.some((ref) => ref.folder !== first.folder)) {
            throw new ImapFailure("protocol", "the messages are in more than one folder");
        }
        const mailbox = await openFolder(first.folder, readOnly);
        if (refs.some((ref) => ref.uidValidity !== Number(mailbox.uidValidity))) {
            throw new ImapFailure(
                "protocol",
                `UIDVALIDITY of ${first.folder} changed to ${mailbox.uidValidity}; search the folder again`,
            );
        }
        return uidSet(refs);
    }

    function uidSet(refs: MessageRef[]): string {
        return refs.map((ref) => ref.uid).join(",");
    }

    async function listFolders(): Promise<FolderInfo[]> {
        const entries = await client.list();
        return entries.map((entry) =>
            entry.specialUse !== undefined && entry.specialUseSource === "extension"
                ? { path: entry.path, specialUse: entry.specialUse }
                : { path: entry.path },
        );
    }

    return {
        listFolders: () => guarded(listFolders),
        specialFolder: (kind) => guarded(async () => pickSpecialFolder(await listFolders(), kind)),
        search: (folder, query, limit) =>
            guarded(async () => {
                const mailbox = await openFolder(folder, true);
                const found = await client.search(searchCriteria(query), { uid: true });
                const uids = found === false || found === undefined ? [] : found.toSorted((a, b) => b - a);
                return uids.slice(0, limit).map((uid) => ({ folder, uidValidity: Number(mailbox.uidValidity), uid }));
            }),
        fetchMessage: (ref) =>
            guarded(async () => {
                const uids = await openForRefs([ref], true);
                const message = await client.fetchOne(uids, { source: true }, { uid: true });
                if (message === false || message.source === undefined) {
                    throw new ImapFailure("protocol", `no message with UID ${ref.uid} in ${ref.folder}`);
                }
                return message.source;
            }),
        move: (refs, target) =>
            guarded(async () => {
                if (!client.capabilities.has("MOVE")) {
                    throw new ImapFailure("protocol", "the server lacks the MOVE capability, so nothing was moved");
                }
                const folders = await listFolders();
                if (!folders.some((folder) => folder.path === target)) {
                    throw new ImapFailure("protocol", `no folder ${target} to move to; nothing was moved`);
                }
                const uids = await openForRefs(refs, false);
                await client.messageMove(uids, target, { uid: true });
            }),
        setFlags: (refs, changes) =>
            guarded(async () => {
                const uids = await openForRefs(refs, false);
                for (const name of ["seen", "flagged", "answered"] as const) {
                    const wanted = changes[name];
                    if (wanted === undefined) continue;
                    if (wanted) await client.messageFlagsAdd(uids, [FLAG_NAMES[name]], { uid: true });
                    else await client.messageFlagsRemove(uids, [FLAG_NAMES[name]], { uid: true });
                }
            }),
        append: (folder, raw, flags) =>
            guarded(async () => {
                await client.append(folder, raw as Buffer, flags);
            }),
        hasMessageId: (folder, messageId) =>
            guarded(async () => {
                await openFolder(folder, true);
                const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
                return found !== false && found !== undefined && found.length > 0;
            }),
        inboxState: () =>
            guarded(async () => {
                const mailbox = await client.mailboxOpen(INBOX);
                return { uidValidity: Number(mailbox.uidValidity), uidNext: mailbox.uidNext };
            }),
        fetchRaw: (uid) =>
            guarded(async () => {
                const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
                if (message === false || message.source === undefined) {
                    throw new ImapFailure("protocol", `no message with UID ${uid} in ${INBOX}`);
                }
                return message.source;
            }),
        onNewMail(listener) {
            client.on("exists", () => listener());
            // The library starts IDLE by itself only after a quiet spell; start it now so the listener hears at once.
            void client.idle({ whenFree: true }).catch(() => undefined);
        },
        async logout() {
            try {
                await client.logout();
            } catch {
                // The connection was already lost; closing releases the socket, which is all a logout is for.
                client.close();
            }
        },
    };
}
