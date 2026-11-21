/**
 * The `bob mail` commands that set an account up (S-009 REQ-017): `create`, `change` and `signin`. A secret is read by
 * `secret_prompt.ts`, never from a flag or the environment. The service validates every value, so a refusal is printed
 * as the service gives it. Imports no daemon code.
 */
import { createClient } from "../client/client.ts";
import { nodeTransport } from "../client/node_transport.ts";
import type { MailAccountView } from "../service/mail_operations.ts";
import type { CommandInput, OptionSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { socketPathFor, withClient } from "./connection.ts";
import { followFeed } from "./feed_follower.ts";
import { mailCommand, namePositional, printAnswer } from "./mail_command_kit.ts";
import { formatAccountDetail, formatSignInStart } from "./mail_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import { readSecret } from "./secret_prompt.ts";

const TEXT_SETTINGS = {
    kind: "kind",
    address: "address",
    "imap-host": "imap_host",
    "imap-security": "imap_security",
    "smtp-host": "smtp_host",
    "smtp-security": "smtp_security",
    login: "login",
    auth: "auth",
    "client-id": "client_id",
    tenant: "tenant",
    "triage-role": "triage_role",
} as const;
const NUMBER_SETTINGS = {
    "imap-port": "imap_port",
    "smtp-port": "smtp_port",
    "check-interval": "check_interval_seconds",
} as const;
// The auths that keep a secret of the team member's: the password, or the client secret of the app.
const SECRET_KEYS: Record<string, "password" | "clientSecret"> = {
    password: "password",
    google: "clientSecret",
    microsoft_app: "clientSecret",
};
const SECRET_LABELS = { password: "Password", clientSecret: "Client secret" } as const;

const text = (description: string): OptionSpec => ({ type: "string", description });
const SETTING_OPTIONS: Record<string, OptionSpec> = {
    kind: text("owned or monitored."),
    address: text("The account's email address."),
    "imap-host": text("The IMAP server."),
    "imap-port": text("The IMAP port."),
    "imap-security": text("tls, starttls or none."),
    "smtp-host": text("The SMTP server."),
    "smtp-port": text("The SMTP port."),
    "smtp-security": text("tls, starttls or none."),
    login: text("The login name, when it is not the address."),
    auth: text("password, password_command, google, microsoft or microsoft_app."),
    "password-command": {
        type: "string",
        multiple: true,
        description: "One word of the command that prints the password; repeat for each word.",
    },
    "client-id": text("The OAuth client ID."),
    tenant: text("The Microsoft tenant."),
    "check-interval": text("Seconds between checks of the inbox."),
    "triage-role": text("The role that triages the account's mail."),
    allow: { type: "string", multiple: true, description: "An address or @domain allowed; repeat for several." },
    "secret-stdin": { type: "boolean", description: "Read the secret from standard input, not the terminal." },
};

class UsageError extends Error {}

function wholeNumber(flag: string, value: string): number {
    if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} must be a whole number, not "${value}".`);
    return Number(value);
}

function stringsOf(value: CommandInput["options"][string]): string[] {
    return Array.isArray(value) ? value : [];
}

// The flags given, as the keys of a `[[mail_account]]` table.
function settingsOf(input: CommandInput): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    for (const [flag, key] of Object.entries(TEXT_SETTINGS)) {
        const value = input.options[flag];
        if (typeof value === "string") table[key] = value;
    }
    for (const [flag, key] of Object.entries(NUMBER_SETTINGS)) {
        const value = input.options[flag];
        if (typeof value === "string") table[key] = wholeNumber(flag, value);
    }
    const command = stringsOf(input.options["password-command"]);
    if (command.length > 0) table.password_command = command;
    return table;
}

async function readSecretFor(input: CommandInput, key: "password" | "clientSecret"): Promise<string> {
    const fromStdin = input.options["secret-stdin"] === true;
    try {
        return await readSecret({ io: input.io, prompt: `${SECRET_LABELS[key]}: `, fromStdin });
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }
}

// Runs the action, turning a bad flag or an unreadable secret into the usage exit.
async function orUsage(input: CommandInput, action: () => Promise<number>): Promise<number> {
    try {
        return await action();
    } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        writeError(input.io, error.message);
        return EXIT_CODES.usage;
    }
}

const accountText = (answer: { account: MailAccountView }): string => formatAccountDetail(answer.account);

export const mailCreate = mailCommand(
    {
        verb: "create",
        summary: "Create a mail account; a password or client secret is typed or read with --secret-stdin.",
        positionals: [namePositional],
        options: SETTING_OPTIONS,
    },
    (client, input) =>
        orUsage(input, async () => {
            const table = settingsOf(input);
            const secretKey = SECRET_KEYS[String(table.auth)];
            const secret = secretKey === undefined ? {} : { [secretKey]: await readSecretFor(input, secretKey) };
            const allow = stringsOf(input.options.allow);
            const answer = (await client.invoke("mail.accounts.create", {
                name: input.positionals[0],
                ...table,
                ...(allow.length > 0 && { allow }),
                ...secret,
            })) as { account: MailAccountView };
            return printAnswer(input, answer, accountText(answer));
        }),
);

// The allowlist after `--allow` and `--disallow`, from the account's current one.
function changedAllow(current: string[], input: CommandInput): string[] | undefined {
    const added = stringsOf(input.options.allow);
    const removed = stringsOf(input.options.disallow);
    if (added.length === 0 && removed.length === 0) return undefined;
    return [...new Set([...current, ...added])].filter((entry) => !removed.includes(entry));
}

export const mailChange = mailCommand(
    {
        verb: "change",
        summary: "Change a mail account; --new-secret reads a new secret as create does.",
        positionals: [namePositional],
        options: {
            ...SETTING_OPTIONS,
            disallow: {
                type: "string",
                multiple: true,
                description: "An allowed entry to remove; repeat for several.",
            },
            "new-secret": { type: "boolean", description: "Read a new password or client secret." },
        },
    },
    (client, input) =>
        orUsage(input, async () => {
            const [name] = input.positionals;
            const table = settingsOf(input);
            const needsAccount = input.options["new-secret"] === true || changedAllow([], input) !== undefined;
            const current = needsAccount
                ? ((await client.invoke("mail.accounts.get", { name })) as { account: MailAccountView }).account
                : undefined;
            const allow = changedAllow(current?.allow ?? [], input);
            const secretKey =
                input.options["new-secret"] === true ? SECRET_KEYS[String(table.auth ?? current?.auth)] : undefined;
            if (input.options["new-secret"] === true && secretKey === undefined) {
                throw new UsageError(`The account's authentication ${current?.auth} keeps no secret.`);
            }
            const secret = secretKey === undefined ? {} : { [secretKey]: await readSecretFor(input, secretKey) };
            const answer = (await client.invoke("mail.accounts.change", {
                name,
                ...table,
                ...(allow !== undefined && { allow }),
                ...secret,
            })) as { account: MailAccountView };
            return printAnswer(input, answer, accountText(answer));
        }),
);

type AccountStatusDelta = { type: string; name?: string; status?: string; lastError?: { message: string } };

// Prints the start, then follows the instance feed until the account is `ready` or the sign-in ends `needs_sign_in`.
async function signIn(input: CommandInput): Promise<number> {
    const { io } = input;
    const [name] = input.positionals;
    return withClient(input, async () => {
        const stop = new AbortController();
        const requestStop = () => stop.abort();
        process.once("SIGINT", requestStop);
        let isStarted = false;
        let exitCode: number = EXIT_CODES.ok;
        const end = (code: number) => {
            exitCode = code;
            stop.abort();
        };
        try {
            await followFeed({
                connect: () => createClient(nodeTransport({ socketPath: socketPathFor(input) })),
                scope: { scope: "instance" },
                signal: stop.signal,
                isUnreachableFatalAtStart: true,
                onNotice: (notice) => writeError(io, notice),
                async onSnapshot(_snapshot, client) {
                    if (isStarted) return;
                    // The feed is open before the sign-in starts, so no change of the account is missed.
                    const start = (await client.invoke("mail.accounts.signin", { name })) as Parameters<
                        typeof formatSignInStart
                    >[0];
                    isStarted = true;
                    if (input.json) writeJson(io, start);
                    else writeLine(io, formatSignInStart(start));
                },
                async onDelta(delta) {
                    const change = delta as AccountStatusDelta;
                    if (!isStarted || change.type !== "mail_account_status" || change.name !== name) return;
                    if (change.status !== "ready" && change.status !== "needs_sign_in") return;
                    if (input.json) writeJson(io, delta);
                    if (change.status === "ready") {
                        if (!input.json) writeLine(io, `${name} is ready`);
                        return end(EXIT_CODES.ok);
                    }
                    writeError(io, `The sign-in of ${name} failed: ${change.lastError?.message ?? "no reason given"}`);
                    end(EXIT_CODES.refused);
                },
            });
        } finally {
            process.off("SIGINT", requestStop);
        }
        return exitCode;
    });
}

export const mailSignIn = mailCommand(
    {
        verb: "signin",
        summary: "Sign in a google or microsoft account and wait until it is ready.",
        positionals: [namePositional],
        options: {},
    },
    (_client, input) => signIn(input),
);
