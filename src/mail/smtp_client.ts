import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { createTransport } from "nodemailer";
import type { Credential } from "../accounts/providers.ts";
import type { MailSecurity } from "./mail_model.ts";

export type SmtpOptions = {
    host: string;
    port: number;
    security: MailSecurity;
    credential: Credential;
    /** An abort ends the connection a login check is making or using. Sending ignores it. */
    signal?: AbortSignal;
};

export type SmtpEnvelope = { from: string; to: string[] };

export type SmtpRefusal = { address: string; answer: string };

/**
 * What became of one message:
 * - `sent`: the server took it, for `accepted`; `refused` lists the recipients it turned down with its answers.
 * - `not_taken`: it failed before the server took the message, so trying again later is safe.
 * - `refused`: a permanent `5xx` to the sender, to every recipient or to the message; never try again.
 * - `unknown`: the connection was lost after the data and before the final answer; the server may have the message.
 */
export type SmtpOutcome =
    | { kind: "sent"; accepted: string[]; refused: SmtpRefusal[] }
    | { kind: "not_taken"; message: string }
    | { kind: "refused"; answer: string }
    | { kind: "unknown"; message: string };

export type SmtpLoginCheck = { ok: true } | { ok: false; message: string };

const TIMEOUT_MS = 30_000;

type SmtpError = Error & {
    code?: string;
    command?: string;
    response?: string;
    responseCode?: number;
};

function transportFor(options: SmtpOptions, socket?: Socket) {
    const { credential } = options;
    return createTransport({
        ...(socket !== undefined && { socket }),
        host: options.host,
        port: options.port,
        secure: options.security === "tls",
        requireTLS: options.security === "starttls",
        ignoreTLS: options.security === "none",
        auth:
            "password" in credential
                ? { user: credential.user, pass: credential.password }
                : { type: "OAuth2", user: credential.user, accessToken: credential.accessToken },
        logger: false,
        debug: false,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
        dnsTimeout: TIMEOUT_MS,
    });
}

/** The server's words for a failure, with the credential left out in case a library message quotes it. */
function messageOf(error: unknown, credential: Credential): string {
    const cause = error as SmtpError;
    let message = cause.response ?? cause.message ?? "SMTP failure";
    const secret = "password" in credential ? credential.password : credential.accessToken;
    if (secret !== "") message = message.replaceAll(secret, "[redacted]");
    return message === "" ? "SMTP failure" : message;
}

export async function checkSmtpLogin(options: SmtpOptions): Promise<SmtpLoginCheck> {
    // The transport connects a socket it is given, so closing that socket ends the check wherever it stands.
    const socket = new Socket();
    const end = () => socket.destroy();
    options.signal?.addEventListener("abort", end, { once: true });
    if (options.signal?.aborted) end();
    const transport = transportFor(options, socket);
    try {
        await transport.verify();
        return { ok: true };
    } catch (error) {
        return { ok: false, message: messageOf(error, options.credential) };
    } finally {
        options.signal?.removeEventListener("abort", end);
        transport.close();
    }
}

const PERMANENT = 500;

/** A `5xx` to the sender, a recipient or the message; a refused login is a failure for now, not a refusal. */
function isPermanentRefusal(error: SmtpError): boolean {
    return (error.code === "EENVELOPE" || error.code === "EMESSAGE") && (error.responseCode ?? 0) >= PERMANENT;
}

type Rejection = { recipient?: string; response?: string; message: string };

function refusalsOf(rejected: Rejection[] | undefined): SmtpRefusal[] {
    return (rejected ?? []).map((entry) => ({
        address: entry.recipient ?? "",
        answer: entry.response ?? entry.message,
    }));
}

/** Sends the bytes as they are to the envelope's recipients and reports what became of the message. */
export async function sendRaw(
    options: SmtpOptions & { envelope: SmtpEnvelope; raw: Uint8Array },
): Promise<SmtpOutcome> {
    const transport = transportFor(options);
    // nodemailer buffers the message early, so the source stream ending proves nothing. The stream it hands the
    // connection is only consumed once the server has answered DATA with 354, which is when the bytes go out.
    let isDataSent = false;
    transport.use("stream", (mail, done) => {
        const original = mail.message.createReadStream.bind(mail.message);
        mail.message.createReadStream = () => {
            const wrapped = original().pipe(new PassThrough());
            wrapped.once("resume", () => {
                isDataSent = true;
            });
            return wrapped;
        };
        done();
    });
    try {
        const info = await transport.sendMail({ envelope: options.envelope, raw: Buffer.from(options.raw) });
        return { kind: "sent", accepted: info.accepted.map(String), refused: refusalsOf(info.rejectedErrors) };
    } catch (error) {
        const failure = error as SmtpError;
        const message = messageOf(failure, options.credential);
        if (isPermanentRefusal(failure)) return { kind: "refused", answer: message };
        if (isDataSent && failure.responseCode === undefined) return { kind: "unknown", message };
        return { kind: "not_taken", message };
    } finally {
        transport.close();
    }
}
