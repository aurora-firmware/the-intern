import { ImapFlow, type ImapFlowError } from "imapflow";
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
    /** The limit on connecting, the greeting and each answer. Defaults to 30 seconds; a test shortens it. */
    timeoutMs?: number;
};

export type ImapConnection = {
    /** Selects INBOX and returns its UIDVALIDITY and UIDNEXT. */
    inboxState(): Promise<{ uidValidity: number; uidNext: number }>;
    /** Reads a message's bytes with BODY.PEEK[], so no flag changes. */
    fetchRaw(uid: number): Promise<Uint8Array>;
    /** Calls the listener each time the server announces a message in INBOX. */
    onNewMail(listener: () => void): void;
    logout(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const client = new ImapFlow({
        host: options.host,
        port: options.port,
        secure: options.security === "tls",
        doSTARTTLS: options.security === "starttls",
        auth: authOf(options.credential),
        logger: false,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        maxIdleTime: options.idleSeconds * 1000,
    });
    // imapflow emits `error` for a lost connection and throws when nobody listens. The command that was running
    // rejects with the same error, and that rejection is what the caller sees.
    client.on("error", () => undefined);
    await guarded(() => client.connect());

    return {
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
